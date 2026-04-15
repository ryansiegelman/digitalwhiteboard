const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
const config = require('./config');

// Enable CORS — configured via CORS_ORIGINS env var (comma-separated list, or '*' for all)
function buildCorsOrigins(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '*') return '*';
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}
const corsOrigins = buildCorsOrigins(config.CORS_ORIGINS);
app.use(cors({
  origin: corsOrigins,
  credentials: corsOrigins !== '*'
}));

// Raw body capture for webhook signature verification (must come before express.json)
app.use('/webhook', express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf-8');
  }
}));

app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    webhookMode: config.WEBHOOK_MODE
  });
});

// Location mapping — configured via LOCATIONS_JSON env var
const LOCATIONS = {};
for (const loc of config.LOCATIONS) {
  LOCATIONS[loc.slug] = { id: loc.id, name: loc.name };
}

// Reverse lookup: businessId → location key
const BUSINESS_ID_TO_LOCATION = {};
for (const [key, loc] of Object.entries(LOCATIONS)) {
  BUSINESS_ID_TO_LOCATION[loc.id] = key;
}

app.get('/dogs', (req, res) => {
  const location = req.query.location || 'default';
  const filePath = location === 'default'
    ? path.join(__dirname, 'dogs.json')
    : path.join(__dirname, `dogs-${location}.json`);

  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, 'utf-8');
    res.json(JSON.parse(data));
  } else {
    res.json([]);
  }
});

app.get('/locations', (req, res) => {
  res.json({
    businessName: config.BUSINESS_NAME,
    locations: LOCATIONS
  });
});

// --- Webhook handling ---

const processedDeliveries = new Set();
const MAX_DELIVERY_IDS = 1000;

function verifyWebhookSignature(req) {
  if (!config.WEBHOOK_SECRET) return false;

  const clientId = req.headers['x-moe-client-id'] || '';
  const nonce = req.headers['x-moe-nonce'] || '';
  const timestamp = req.headers['x-moe-timestamp'] || '';
  const signature = req.headers['x-moe-signature-256'] || '';

  if (!signature || !req.rawBody) return false;

  const raw = clientId + nonce + timestamp + req.rawBody;
  const expected = crypto
    .createHmac('sha256', config.WEBHOOK_SECRET)
    .update(raw)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

function updateDogsFromWebhook(appointment) {
  const businessId = appointment.businessId;
  const locationKey = BUSINESS_ID_TO_LOCATION[businessId];
  if (!locationKey) {
    console.log(`⚠️ Webhook: unknown businessId ${businessId}`);
    return;
  }

  const checkOutTime = appointment.checkOutTime;
  if (!checkOutTime) return;

  const newDogs = (appointment.petServiceDetails || []).map(detail => ({
    name: detail.pet?.name || 'Unknown',
    imageUrl: detail.pet?.photo || '',
    checkOutTime,
    appointmentId: appointment.id,
    serviceItemType: (detail.serviceDetails?.[0]?.serviceItemType) || ''
  }));

  if (newDogs.length === 0) return;

  // Update location-specific file
  const fileName = `dogs-${locationKey}.json`;
  mergeDogsIntoFile(fileName, newDogs);

  // Also update default file if this is the default business
  if (businessId === config.BUSINESS_ID) {
    mergeDogsIntoFile('dogs.json', newDogs);
  }

  console.log(`🔔 Webhook: added ${newDogs.length} dog(s) to ${fileName}`);
}

function mergeDogsIntoFile(fileName, newDogs) {
  const filePath = path.join(__dirname, fileName);
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {}

  // Merge and deduplicate by appointmentId + name
  const merged = [...newDogs, ...existing];
  const seen = new Set();
  const deduped = merged.filter(dog => {
    const key = `${dog.appointmentId}-${dog.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => new Date(b.checkOutTime) - new Date(a.checkOutTime));
  const trimmed = deduped.slice(0, 5);

  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2));
}

app.post('/webhook', (req, res) => {
  // Verify signature
  if (!verifyWebhookSignature(req)) {
    console.log('❌ Webhook: invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Deduplicate by delivery ID
  const deliveryId = req.headers['x-moe-delivery-id'];
  if (deliveryId) {
    if (processedDeliveries.has(deliveryId)) {
      return res.status(200).json({ status: 'already processed' });
    }
    processedDeliveries.add(deliveryId);
    if (processedDeliveries.size > MAX_DELIVERY_IDS) {
      const first = processedDeliveries.values().next().value;
      processedDeliveries.delete(first);
    }
  }

  const body = req.body;
  const eventType = body.type || body.eventType;

  // Health check
  if (eventType === 'HEALTH_CHECK') {
    console.log('✅ Webhook: HEALTH_CHECK received');
    return res.status(200).json({ status: 'ok' });
  }

  // Appointment finished
  if (eventType === 'APPOINTMENT_FINISHED') {
    try {
      let appointment = body.appointment;

      // Handle base64-encoded string format
      if (typeof appointment === 'string') {
        appointment = JSON.parse(Buffer.from(appointment, 'base64').toString('utf-8'));
      }

      if (appointment) {
        updateDogsFromWebhook(appointment);
      }
    } catch (err) {
      console.error('❌ Webhook: failed to process appointment:', err.message);
    }
    return res.status(200).json({ status: 'processed' });
  }

  // Unknown event type
  console.log(`⚠️ Webhook: unhandled event type "${eventType}"`);
  res.status(200).json({ status: 'ignored' });
});

// --- Polling (existing logic) ---

async function fetchAppointmentsForLocation(businessId, fileName) {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - config.DOG_CHECKED_BEFORE * 60 * 60 * 1000).toISOString();
    const end = now.toISOString();

    const rawBody = JSON.stringify({
      pagination: {
        pageSize: 50,
        pageToken: '1'
      },
      companyId: config.COMPANY_ID,
      businessIds: [businessId],
      filter: {
        checkOutTime: {
          startTime: start,
          endTime: end
        },
        statuses: ['FINISHED']
      }
    });

    const response = await axios.request({
      method: 'post',
      url: 'https://openapi.moego.pet/v1/appointments:list',
      headers: {
        Authorization: `Basic ${config.AUTH_KEY}`,
        'Content-Type': 'text/plain'
      },
      data: rawBody
    });

    const appointments = response.data.appointments || [];
    let dogs = [];

    appointments.forEach(appointment => {
      const checkOutTime = appointment.checkOutTime;
      appointment.petServiceDetails.forEach(detail => {
        const pet = detail.pet;
        dogs.push({
          name: pet.name,
          imageUrl: pet.photo,
          checkOutTime: checkOutTime,
          appointmentId: appointment.id,
          serviceItemType: (detail.serviceDetails[0]?.serviceItemType) || ''
        });
      });
    });

    dogs.sort((a, b) => new Date(b.checkOutTime) - new Date(a.checkOutTime));
    dogs = dogs.slice(0, 5);

    fs.writeFileSync(path.join(__dirname, fileName), JSON.stringify(dogs, null, 2));
    console.log(`✅ Updated ${fileName} with ${dogs.length} entries.`);
  } catch (err) {
    console.error(`❌ Failed to fetch appointments for ${fileName}:`, err.response?.data || err.message);
  }
}

async function fetchAllLocations() {
  // Fetch for default location
  await fetchAppointmentsForLocation(config.BUSINESS_ID, 'dogs.json');

  // Fetch for all locations
  for (const [key, location] of Object.entries(LOCATIONS)) {
    await fetchAppointmentsForLocation(location.id, `dogs-${key}.json`);
  }
}

// --- Stale entry cleanup (for webhook/hybrid modes) ---

function cleanupStaleEntries() {
  const cutoff = new Date(Date.now() - config.DOG_CHECKED_BEFORE * 60 * 60 * 1000);

  const files = ['dogs.json', ...Object.keys(LOCATIONS).map(k => `dogs-${k}.json`)];
  for (const fileName of files) {
    const filePath = path.join(__dirname, fileName);
    try {
      const dogs = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const filtered = dogs.filter(d => new Date(d.checkOutTime) > cutoff);
      if (filtered.length !== dogs.length) {
        fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2));
        console.log(`🧹 Cleanup: removed ${dogs.length - filtered.length} stale entries from ${fileName}`);
      }
    } catch {}
  }
}

// --- Startup logic based on WEBHOOK_MODE ---

const mode = config.WEBHOOK_MODE;

if (mode === 'poll' || mode === 'hybrid') {
  setInterval(fetchAllLocations, config.POLL_INTERVAL_MS);
  fetchAllLocations();
  console.log(`📡 Polling active (every ${config.POLL_INTERVAL_MS / 1000}s)`);
}

if (mode === 'webhook') {
  // One-time seed on startup, then rely on webhooks
  fetchAllLocations();
  console.log('📡 Webhook-only mode: initial seed complete, polling disabled');
}

if (mode === 'hybrid' || mode === 'webhook') {
  setInterval(cleanupStaleEntries, config.CLEANUP_INTERVAL_MS);
  console.log(`🧹 Stale entry cleanup active (every ${config.CLEANUP_INTERVAL_MS / 1000}s)`);
}

app.listen(config.PORT, () => {
  console.log(`✅ Server running at http://localhost:${config.PORT} [mode: ${mode}]`);
  console.log(`📊 Health check: http://localhost:${config.PORT}/health`);
  console.log(`🐕 Dogs endpoint: http://localhost:${config.PORT}/dogs`);
  if (mode !== 'poll') {
    console.log(`� Webhook endpoint: http://localhost:${config.PORT}/webhook`);
  }
});
