const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
const config = require('./config');

// Enable CORS
function buildCorsOrigins(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '*') return '*';
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}
const corsOrigins = buildCorsOrigins(config.CORS_ORIGINS);
app.use(cors({ origin: corsOrigins, credentials: corsOrigins !== '*' }));

app.use('/webhook', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf-8'); }
}));

app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), webhookMode: config.WEBHOOK_MODE });
});

const LOCATIONS = {};
for (const loc of config.LOCATIONS) { LOCATIONS[loc.slug] = { id: loc.id, name: loc.name }; }
const BUSINESS_ID_TO_LOCATION = {};
for (const [key, loc] of Object.entries(LOCATIONS)) { BUSINESS_ID_TO_LOCATION[loc.id] = key; }

app.get('/dogs', (req, res) => {
  const location = req.query.location || 'default';
  const filePath = location === 'default' ? path.join(__dirname, 'dogs.json') : path.join(__dirname, `dogs-${location}.json`);
  if (fs.existsSync(filePath)) { res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8'))); } else { res.json([]); }
});

app.get('/locations', (req, res) => {
  res.json({ businessName: config.BUSINESS_NAME, locations: LOCATIONS });
});

// Debug endpoints to discover correct MoeGo IDs
app.get('/debug-moego', async (req, res) => {
  try {
    const r = await axios.request({
      method: 'post', url: 'https://openapi.moego.pet/v1/companies:list',
      headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
      data: JSON.stringify({ pagination: { pageSize: 10, pageToken: '1' } })
    });
    res.json({ companies: r.data });
  } catch (err) { res.json({ error: err.response?.data || err.message }); }
});

app.get('/debug-businesses', async (req, res) => {
  const companyId = req.query.companyId;
  try {
    const r = await axios.request({
      method: 'post', url: 'https://openapi.moego.pet/v1/businesses:list',
      headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
      data: JSON.stringify({ pagination: { pageSize: 10, pageToken: '1' }, companyId })
    });
    res.json({ businesses: r.data });
  } catch (err) { res.json({ error: err.response?.data || err.message }); }
});

app.get('/debug-appts', async (req, res) => {
  const { companyId, businessId } = req.query;
  try {
    const r = await axios.request({
      method: 'post', url: 'https://openapi.moego.pet/v1/appointments:list',
      headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
      data: JSON.stringify({
        pagination: { pageSize: 5, pageToken: '1' },
        companyId, businessIds: [businessId],
        filter: { statuses: ['FINISHED'] }
      })
    });
    res.json(r.data);
  } catch (err) { res.json({ error: err.response?.data || err.message }); }
});

function verifyWebhookSignature(req) {
  if (!config.WEBHOOK_SECRET) return false;
  const clientId = req.headers['x-moe-client-id'] || '';
  const nonce = req.headers['x-moe-nonce'] || '';
  const timestamp = req.headers['x-moe-timestamp'] || '';
  const signature = req.headers['x-moe-signature-256'] || '';
  if (!signature || !req.rawBody) return false;
  const raw = clientId + nonce + timestamp + req.rawBody;
  const expected = crypto.createHmac('sha256', config.WEBHOOK_SECRET).update(raw).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch { return false; }
}

function mergeDogsIntoFile(fileName, newDogs) {
  const filePath = path.join(__dirname, fileName);
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
  const merged = [...newDogs, ...existing];
  const seen = new Set();
  const deduped = merged.filter(dog => { const key = `${dog.appointmentId}-${dog.name}`; if (seen.has(key)) return false; seen.add(key); return true; });
  deduped.sort((a, b) => new Date(b.checkOutTime) - new Date(a.checkOutTime));
  fs.writeFileSync(filePath, JSON.stringify(deduped.slice(0, 5), null, 2));
}

function updateDogsFromWebhook(appointment) {
  const businessId = appointment.businessId;
  const locationKey = BUSINESS_ID_TO_LOCATION[businessId];
  if (!locationKey) { console.log(`⚠️ Webhook: unknown businessId ${businessId}`); return; }
  const checkOutTime = appointment.checkOutTime;
  if (!checkOutTime) return;
  const newDogs = (appointment.petServiceDetails || []).map(detail => ({
    name: detail.pet?.name || 'Unknown', imageUrl: detail.pet?.photo || '',
    checkOutTime, appointmentId: appointment.id,
    serviceItemType: (detail.serviceDetails?.[0]?.serviceItemType) || ''
  }));
  if (newDogs.length === 0) return;
  mergeDogsIntoFile(`dogs-${locationKey}.json`, newDogs);
  if (businessId === config.BUSINESS_ID) mergeDogsIntoFile('dogs.json', newDogs);
  console.log(`🔔 Webhook: added ${newDogs.length} dog(s) to dogs-${locationKey}.json`);
}

app.post('/webhook', (req, res) => {
  if (!verifyWebhookSignature(req)) { console.log('❌ Webhook: invalid signature'); return res.status(401).json({ error: 'Invalid signature' }); }
  const deliveryId = req.headers['x-moe-delivery-id'];
  const body = req.body;
  const eventType = body.type || body.eventType;
  if (eventType === 'HEALTH_CHECK') { console.log('✅ Webhook: HEALTH_CHECK received'); return res.status(200).json({ status: 'ok' }); }
  if (eventType === 'APPOINTMENT_FINISHED') {
    try {
      let appointment = body.appointment;
      if (typeof appointment === 'string') appointment = JSON.parse(Buffer.from(appointment, 'base64').toString('utf-8'));
      if (appointment) updateDogsFromWebhook(appointment);
    } catch (err) { console.error('❌ Webhook: failed to process appointment:', err.message); }
    return res.status(200).json({ status: 'processed' });
  }
  res.status(200).json({ status: 'ignored' });
});

async function fetchAppointmentsForLocation(businessId, fileName) {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - config.DOG_CHECKED_BEFORE * 60 * 60 * 1000).toISOString();
    const end = now.toISOString();
    const rawBody = JSON.stringify({
      pagination: { pageSize: 50, pageToken: '1' },
      companyId: config.COMPANY_ID,
      businessIds: [businessId],
      filter: { checkOutTime: { startTime: start, endTime: end }, statuses: ['FINISHED'] }
    });
    const response = await axios.request({
      method: 'post', url: 'https://openapi.moego.pet/v1/appointments:list',
      headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
      data: rawBody
    });
    const appointments = response.data.appointments || [];
    let dogs = [];
    appointments.forEach(appointment => {
      const checkOutTime = appointment.checkOutTime;
      appointment.petServiceDetails.forEach(detail => {
        const pet = detail.pet;
        dogs.push({ name: pet.name, imageUrl: pet.photo, checkOutTime, appointmentId: appointment.id, serviceItemType: (detail.serviceDetails[0]?.serviceItemType) || '' });
      });
    });
    dogs.sort((a, b) => new Date(b.checkOutTime) - new Date(a.checkOutTime));
    dogs = dogs.slice(0, 5);
    fs.writeFileSync(path.join(__dirname, fileName), JSON.stringify(dogs, null, 2));
    console.log(`✅ Updated ${fileName} with ${dogs.length} entries.`);
  } catch (err) { console.error(`❌ Failed to fetch appointments for ${fileName}:`, err.response?.data || err.message); }
}

async function fetchAllLocations() {
  await fetchAppointmentsForLocation(config.BUSINESS_ID, 'dogs.json');
  for (const [key, location] of Object.entries(LOCATIONS)) {
    await fetchAppointmentsForLocation(location.id, `dogs-${key}.json`);
  }
}

function cleanupStaleEntries() {
  const cutoff = new Date(Date.now() - config.DOG_CHECKED_BEFORE * 60 * 60 * 1000);
  const files = ['dogs.json', ...Object.keys(LOCATIONS).map(k => `dogs-${k}.json`)];
  for (const fileName of files) {
    const filePath = path.join(__dirname, fileName);
    try {
      const dogs = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const filtered = dogs.filter(d => new Date(d.checkOutTime) > cutoff);
      if (filtered.length !== dogs.length) { fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2)); }
    } catch {}
  }
}

const mode = config.WEBHOOK_MODE;
if (mode === 'poll' || mode === 'hybrid') { setInterval(fetchAllLocations, config.POLL_INTERVAL_MS); fetchAllLocations(); console.log(`📡 Polling active (every ${config.POLL_INTERVAL_MS / 1000}s)`); }
if (mode === 'webhook') { fetchAllLocations(); console.log('📡 Webhook-only mode: initial seed complete, polling disabled'); }
if (mode === 'hybrid' || mode === 'webhook') { setInterval(cleanupStaleEntries, config.CLEANUP_INTERVAL_MS); }

app.listen(config.PORT, () => {
  console.log(`✅ Server running at http://localhost:${config.PORT} [mode: ${mode}]`);
  console.log(`📊 Health check: http://localhost:${config.PORT}/health`);
  console.log(`🐕 Dogs endpoint: http://localhost:${config.PORT}/dogs`);
  if (mode !== 'poll') console.log(`🔔 Webhook endpoint: http://localhost:${config.PORT}/webhook`);
});