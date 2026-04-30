const express = require('express'); const fs = require('fs'); const path = require('path'); const axios = require('axios'); const cors = require('cors'); const crypto = require('crypto'); const app = express(); const config = require('./config');

// Cache to avoid repeated client lookups
const clientCache = new Map();

// In-memory dismissed IDs store for cross-screen sync
// Map of location -> Set of dismissed appointmentIds
const dismissedStore = new Map();
// Parallel map: location -> Map(id -> timestamp ms) for cleanup
const dismissedTimestamps = new Map();
function getDismissedTimestamps(location) {
  if (!dismissedTimestamps.has(location)) dismissedTimestamps.set(location, new Map());
  return dismissedTimestamps.get(location);
}
// Manually queued checkouts (Front Desk early-trigger)
// Map of location -> Array<dog entry with manual:true>
const manualCheckouts = new Map();
function getManualCheckouts(location) {
  if (!manualCheckouts.has(location)) manualCheckouts.set(location, []);
  return manualCheckouts.get(location);
}
// Cleanup dismissed IDs older than 12 hours
function getDismissedSet(location) {
  if (!dismissedStore.has(location)) dismissedStore.set(location, new Set());
  return dismissedStore.get(location);
}

// Enable CORS
function buildCorsOrigins(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '*') return '*';
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}
const corsOrigins = buildCorsOrigins(config.CORS_ORIGINS);
app.use(cors({ origin: corsOrigins, credentials: corsOrigins !== '*' }));
app.use('/webhook', express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf-8'); } }));
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), webhookMode: config.WEBHOOK_MODE });
});

// Dismissed IDs endpoints for cross-screen sync
app.get('/dismissed', (req, res) => {
  const location = req.query.location || 'default';
  const ids = Array.from(getDismissedSet(location));
  res.json({ dismissed: ids });
});

app.post('/dismissed', (req, res) => {
  const location = req.query.location || req.body.location || 'default';
  const id = req.body.id || req.body.appointmentId || '';
  if (id) {
    getDismissedSet(location).add(String(id));
    getDismissedTimestamps(location).set(String(id), Date.now());
    console.log('Dismissed: ' + id + ' for location: ' + location);
  }
  res.json({ ok: true, dismissed: Array.from(getDismissedSet(location)) });
});

app.delete('/dismissed', (req, res) => {
  const location = req.query.location || 'default';
  if (dismissedStore.has(location)) dismissedStore.get(location).clear();
  if (dismissedTimestamps.has(location)) dismissedTimestamps.get(location).clear();
  console.log('Dismissed list cleared for location: ' + location);
  res.json({ ok: true, dismissed: [] });
});

// In-house dogs (currently CHECKED_IN), no time filter - for manual queue search
app.post('/customer-names', async (req, res) => {
  const ids = (req.body && req.body.customerIds) || [];
  if (!ids.length) return res.json({ names: {} });
  const result = {};
  // Concurrency limit: chunks of 5
  const chunks = [];
  for (let i = 0; i < ids.length; i += 5) chunks.push(ids.slice(i, i + 5));
  for (const chunk of chunks) {
    const lookups = await Promise.all(chunk.map(function(id){ return fetchClientLastName(id).then(function(ln){ return [id, ln]; }); }));
    for (const [id, ln] of lookups) result[id] = ln;
  }
  res.json({ names: result });
});

app.get('/in-house', (req, res) => {
  const location = req.query.location || 'default';
  const filePath = location === 'default' ? path.join(__dirname, 'checkins.json') : path.join(__dirname, 'checkins-' + location + '.json');
  if (fs.existsSync(filePath)) {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } else {
    res.json([]);
  }
});

// Manually queue a dog to the Checking Out panel (early-trigger feature)
app.post('/queue-checkout', (req, res) => {
  const location = req.query.location || req.body.location || 'default';
  const aptId = req.body.appointmentId || req.body.id || '';
  const dogName = req.body.name || '';
  if (!aptId) return res.status(400).json({ error: 'appointmentId required' });
  const filePath = location === 'default' ? path.join(__dirname, 'checkins.json') : path.join(__dirname, 'checkins-' + location + '.json');
  let inHouse = [];
  try { inHouse = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch(e) {}
  const dog = dogName
    ? inHouse.find(function(d){ return d.appointmentId === aptId && d.name === dogName; })
    : inHouse.find(function(d){ return d.appointmentId === aptId; });
  if (!dog) return res.status(404).json({ error: 'dog not in in-house list' });
  const queue = getManualCheckouts(location);
  if (queue.some(function(d){ return d.appointmentId === aptId && d.name === dog.name; })) {
    return res.json({ ok: true, alreadyQueued: true });
  }
  const entry = {
    name: dog.name,
    imageUrl: dog.imageUrl,
    ownerLastName: dog.ownerLastName || '',
    checkOutTime: new Date().toISOString(),
    appointmentId: dog.appointmentId,
    customerId: dog.customerId,
    serviceItemType: dog.serviceItemType,
    serviceName: dog.serviceName,
    lodgingLocation: dog.lodgingLocation || '',
    breed: dog.breed || '',
    manual: true
  };
  queue.unshift(entry);
  console.log('Manual checkout queued: ' + dog.name + ' (' + aptId + ')');
  res.json({ ok: true, dog: entry });
});

app.delete('/queue-checkout', (req, res) => {
  const location = req.query.location || 'default';
  const aptId = req.query.appointmentId || '';
  const dogName = req.query.name || '';
  const queue = getManualCheckouts(location);
  if (dogName) {
    const idx = queue.findIndex(function(d){ return d.appointmentId === aptId && d.name === dogName; });
    if (idx >= 0) queue.splice(idx, 1);
  } else {
    // No name: remove all entries with this aptId (legacy behavior)
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].appointmentId === aptId) queue.splice(i, 1);
    }
  }
  res.json({ ok: true });
});

const LOCATIONS = {};
for (const loc of config.LOCATIONS) {
  LOCATIONS[loc.slug] = { id: loc.id, name: loc.name };
}
const BUSINESS_ID_TO_LOCATION = {};
for (const [key, loc] of Object.entries(LOCATIONS)) {
  BUSINESS_ID_TO_LOCATION[loc.id] = key;
}

function extractServiceName(detail) {
  // Try every serviceDetails item (not just index 0) for a populated name
  for (const sd of (detail && detail.serviceDetails || [])) {
    const candidates = [
      sd.serviceName, sd.name,
      sd.service && sd.service.name,
      sd.service && sd.service.serviceName,
      sd.displayName,
    ];
    for (const c of candidates) {
      if (!c) continue;
      const s = String(c).trim();
      if (s) return s;
    }
  }
  // Fallback to detail-level fields
  const detailCandidates = [
    detail && detail.service && detail.service.name,
    detail && detail.service && detail.service.serviceName,
    detail && detail.serviceName,
    detail && detail.name,
    detail && detail.displayName,
    detail && detail.serviceType,
    detail && detail.type,
  ];
  for (const c of detailCandidates) {
    if (!c) continue;
    const s = String(c).trim();
    if (s) return s;
  }
  return '';
}

function extractLodgingLocation(detail) {
  // MoeGo API uses lodgingUnitName and lodgingTypeName inside serviceDetails items
  // Only boarding/lodging appointments have these populated
  for (const sd of (detail && detail.serviceDetails || [])) {
    const unit = (sd.lodgingUnitName || '').trim();
    const type = (sd.lodgingTypeName || '').trim();
    if (unit) return unit;   // e.g. "Big Pen", "Small Pen", "Suite 1"
    if (type) return type;   // fallback to type name
  }
  return '';
}

// Fill in missing service/lodging info from the location's check-ins file.
// Useful when a checkout comes through with empty serviceDetails but the
// dog's check-in had full data (match by appointmentId, then customerId+name, then name).
function enrichFromCheckins(dogs, locationKey) {
  if (!dogs || dogs.length === 0) return dogs;
  let checkins = [];
  try {
    const fp = path.join(__dirname, 'checkins-' + locationKey + '.json');
    checkins = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { return dogs; }
  return dogs.map(function(d) {
    if (d.lodgingLocation && d.serviceName && d.serviceItemType) return d;
    var match = checkins.find(function(c){ return c.appointmentId && c.appointmentId === d.appointmentId; })
             || (d.customerId && checkins.find(function(c){ return c.customerId && c.customerId === d.customerId && c.name === d.name; }))
             || checkins.find(function(c){ return c.name === d.name && (c.lodgingLocation || c.serviceName); });
    if (match) {
      if (!d.lodgingLocation && match.lodgingLocation) d.lodgingLocation = match.lodgingLocation;
      if (!d.serviceName && match.serviceName) d.serviceName = match.serviceName;
      if (!d.serviceItemType && match.serviceItemType) d.serviceItemType = match.serviceItemType;
    }
    return d;
  });
}

async function fetchClientLastName(customerId) {
  if (!customerId) return '';
  if (clientCache.has(customerId) && clientCache.get(customerId)) return clientCache.get(customerId);
  try {
    const r = await axios.request({
      method: 'post',
      url: 'https://openapi.moego.pet/v1/customers:list',
      headers: { Authorization: 'Basic ' + config.AUTH_KEY, 'Content-Type': 'application/json' },
      data: JSON.stringify({ companyId: config.COMPANY_ID, pagination: { pageSize: 1, pageToken: '1' }, filter: { ids: [customerId] } })
    });
    const customers = (r.data && (r.data.customers || r.data.clients)) || [];
    const match = customers.find(function(c){ return c && c.id === customerId; });
    const client = match || customers[0] || {};
    const ln = client.lastName || client.familyName || client.last_name || '';
    const fn = client.fullName || client.name || '';
    const result = ln || (fn ? fn.trim().split(/\s+/).pop() : '');
    clientCache.set(customerId, result);
    return result;
  } catch (err) {
    console.error('Client lookup failed for', customerId, ':', err.message, err.response && err.response.status);
    clientCache.set(customerId, '');
    return '';
  }
}

function extractBreed(detail) {
  const pet = (detail && detail.pet) || {};
  const candidates = [pet.breed, pet.breedName, pet.breed_name];
  if (Array.isArray(pet.breeds) && pet.breeds.length) {
    const b = pet.breeds[0];
    candidates.push(typeof b === 'string' ? b : (b && (b.name || b.breedName)));
  }
  for (const c of candidates) { if (c) return String(c).trim(); }
  return '';
}

function extractPetPhoto(detail) {
  const pet = (detail && detail.pet) || {};
  const candidates = [
    pet.photo, pet.photoUrl, pet.photoURL, pet.avatar, pet.avatarUrl, pet.avatarURL,
    pet.image, pet.imageUrl, pet.imageURL, pet.picture, pet.pictureUrl,
    Array.isArray(pet.photos) ? pet.photos[0] : null,
    Array.isArray(pet.images) ? pet.images[0] : null,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const s = typeof c === 'string' ? c : (c.url || c.src || '');
    if (s && /^https?:\/\//i.test(s)) return s;
  }
  return '';
}

app.get('/dogs', (req, res) => {
  const location = req.query.location || 'default';
  const filePath = location === 'default'
    ? path.join(__dirname, 'dogs.json')
    : path.join(__dirname, 'dogs-' + location + '.json');
  if (fs.existsSync(filePath)) {
    const all = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const cutoff = Date.now() - 10 * 60 * 1000;
    const recent = all.filter(function(d) {
      const t = d.checkOutTime || d.check_out_time;
      return t && new Date(t).getTime() >= cutoff;
    });
    // Merge manual queue entries; prefer real entries (de-dupe by appointmentId)
    const realKeys = new Set(recent.map(function(d){ return d.appointmentId + ':' + d.name; }));
    const manual = getManualCheckouts(location).filter(function(d){ return !realKeys.has(d.appointmentId + ':' + d.name); });
    res.json(manual.concat(recent));
  } else {
    res.json(getManualCheckouts(location));
  }
});

app.get('/checkins', (req, res) => {
  const location = req.query.location || 'default';
  const filePath = location === 'default'
    ? path.join(__dirname, 'checkins.json')
    : path.join(__dirname, 'checkins-' + location + '.json');
  if (fs.existsSync(filePath)) {
    const all = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const cutoff = Date.now() - 10 * 60 * 1000;
    const recent = all.filter(function(d) {
      const t = d.checkInTime || d.check_in_time;
      return t && new Date(t).getTime() >= cutoff;
    });
    res.json(recent);
  } else {
    res.json([]);
  }
});

app.get('/locations', (req, res) => {
  res.json({ businessName: config.BUSINESS_NAME, locations: LOCATIONS });
});

app.get('/debug-moego', async (req, res) => {
  try {
    const r = await axios.request({ method: 'post', url: 'https://openapi.moego.pet/v1/companies:list', headers: { Authorization: 'Basic ' + config.AUTH_KEY, 'Content-Type': 'text/plain' }, data: JSON.stringify({ pagination: { pageSize: 10, pageToken: '1' } }) });
    res.json({ companies: r.data });
  } catch (err) { res.json({ error: (err.response && err.response.data) || err.message }); }
});

app.get('/debug-businesses', async (req, res) => {
  const companyId = req.query.companyId;
  try {
    const r = await axios.request({ method: 'post', url: 'https://openapi.moego.pet/v1/businesses:list', headers: { Authorization: 'Basic ' + config.AUTH_KEY, 'Content-Type': 'text/plain' }, data: JSON.stringify({ pagination: { pageSize: 10, pageToken: '1' }, companyId: companyId }) });
    res.json({ businesses: r.data });
  } catch (err) { res.json({ error: (err.response && err.response.data) || err.message }); }
});

app.get('/debug-appts', async (req, res) => {
  const companyId = req.query.companyId; const businessId = req.query.businessId;
  try {
    const r = await axios.request({ method: 'post', url: 'https://openapi.moego.pet/v1/appointments:list', headers: { Authorization: 'Basic ' + config.AUTH_KEY, 'Content-Type': 'text/plain' }, data: JSON.stringify({ pagination: { pageSize: 5, pageToken: '1' }, companyId: companyId, businessIds: [businessId], filter: { statuses: ['FINISHED'] } }) });
    res.json(r.data);
  } catch (err) { res.json({ error: (err.response && err.response.data) || err.message }); }
});

app.get('/debug-checkins', async (req, res) => {
  const companyId = req.query.companyId; const businessId = req.query.businessId;
  try {
    const r = await axios.request({ method: 'post', url: 'https://openapi.moego.pet/v1/appointments:list', headers: { Authorization: 'Basic ' + config.AUTH_KEY, 'Content-Type': 'text/plain' }, data: JSON.stringify({ pagination: { pageSize: 5, pageToken: '1' }, companyId: companyId, businessIds: [businessId], filter: { statuses: [req.query.status || 'CHECKED_IN'] } }) });
    res.json(r.data);
  } catch (err) { res.json({ error: (err.response && err.response.data) || err.message }); }
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
  try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch (e) { return false; }
}

function mergeDogsIntoFile(fileName, newDogs, timeField) {
  timeField = timeField || 'checkOutTime';
  const filePath = path.join(__dirname, fileName);
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch (e) {}
  const merged = newDogs.concat(existing);
  const seen = new Set();
  const deduped = merged.filter(function(dog) {
    const key = dog.appointmentId + '-' + dog.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort(function(a, b) { return new Date(b[timeField]) - new Date(a[timeField]); });
  fs.writeFileSync(filePath, JSON.stringify(deduped, null, 2));
}

async function updateDogsFromWebhook(appointment) {
  const businessId = appointment.businessId;
  const locationKey = BUSINESS_ID_TO_LOCATION[businessId];
  if (!locationKey) { console.log('Warning Webhook: unknown businessId ' + businessId); return; }
  const checkOutTime = appointment.checkOutTime;
  if (!checkOutTime) return;
  const ownerLastName = '';
  const newDogs = (appointment.petServiceDetails || []).map(function(detail) {
    return {
      name: detail.pet ? (detail.pet.name || 'Unknown') : 'Unknown',
      imageUrl: extractPetPhoto(detail),
      ownerLastName: ownerLastName,
      checkOutTime: checkOutTime,
      appointmentId: appointment.id,
      customerId: appointment.customerId,
      serviceItemType: (function(sds){ for(var i=0;i<(sds||[]).length;i++){ var t=(sds[i].serviceItemType||'').trim(); if(t) return t; } return ''; })(detail.serviceDetails),
      serviceName: extractServiceName(detail),
      lodgingLocation: extractLodgingLocation(detail),
      breed: extractBreed(detail)
    };
  });
  if (newDogs.length === 0) return;
  const enriched = enrichFromCheckins(newDogs, locationKey);
  mergeDogsIntoFile('dogs-' + locationKey + '.json', enriched, 'checkOutTime');
  if (businessId === config.BUSINESS_ID) mergeDogsIntoFile('dogs.json', enriched, 'checkOutTime');
  console.log('Dog Webhook: added ' + newDogs.length + ' checkout(s)');
}

async function updateCheckinsFromWebhook(appointment) {
  const businessId = appointment.businessId;
  const locationKey = BUSINESS_ID_TO_LOCATION[businessId];
  if (!locationKey) { console.log('Warning Webhook: unknown businessId ' + businessId); return; }
  const checkInTime = appointment.checkInTime;
  if (!checkInTime) return;
  const ownerLastName = '';
  const newDogs = (appointment.petServiceDetails || []).map(function(detail) {
    return {
      name: detail.pet ? (detail.pet.name || 'Unknown') : 'Unknown',
      imageUrl: extractPetPhoto(detail),
      ownerLastName: ownerLastName,
      checkInTime: checkInTime,
      appointmentId: appointment.id,
      serviceItemType: (function(sds){ for(var i=0;i<(sds||[]).length;i++){ var t=(sds[i].serviceItemType||'').trim(); if(t) return t; } return ''; })(detail.serviceDetails),
      serviceName: extractServiceName(detail),
      lodgingLocation: extractLodgingLocation(detail),
      breed: extractBreed(detail)
    };
  });
  if (newDogs.length === 0) return;
  mergeDogsIntoFile('checkins-' + locationKey + '.json', newDogs, 'checkInTime');
  if (businessId === config.BUSINESS_ID) mergeDogsIntoFile('checkins.json', newDogs, 'checkInTime');
  console.log('Dog Webhook: added ' + newDogs.length + ' check-in(s)');
}

app.post('/webhook', async (req, res) => {
  if (!verifyWebhookSignature(req)) { console.log(' Webhook: invalid signature'); return res.status(401).json({ error: 'Invalid signature' }); }
  const body = req.body;
  const eventType = body.type || body.eventType;
  if (eventType === 'HEALTH_CHECK') { console.log(' Webhook: HEALTH_CHECK received'); return res.status(200).json({ status: 'ok' }); }
  let appointment = body.appointment;
  try { if (typeof appointment === 'string') appointment = JSON.parse(Buffer.from(appointment, 'base64').toString('utf-8')); }
  catch (err) { console.error(' Webhook: failed to decode appointment:', err.message); return res.status(200).json({ status: 'decode-error' }); }
  if (eventType === 'APPOINTMENT_FINISHED') {
    try { if (appointment) await updateDogsFromWebhook(appointment); } catch (err) { console.error(' Webhook: failed to process finish:', err.message); }
    return res.status(200).json({ status: 'processed' });
  }
  if (eventType === 'APPOINTMENT_CHECKED_IN' || eventType === 'APPOINTMENT_STARTED' || eventType === 'APPOINTMENT_IN_PROGRESS') {
    try { if (appointment) await updateCheckinsFromWebhook(appointment); } catch (err) { console.error(' Webhook: failed to process check-in:', err.message); }
    return res.status(200).json({ status: 'processed' });
  }
  res.status(200).json({ status: 'ignored' });
});

// Fetch all pages from MoeGo appointments API
async function fetchAllAppointmentPages(baseBody) {
  let allAppointments = []; let pageToken = '1'; let hasMore = true;
  while (hasMore) {
    const body = Object.assign({}, baseBody, { pagination: { pageSize: 100, pageToken: pageToken } });
    const response = await axios.request({ method: 'post', url: 'https://openapi.moego.pet/v1/appointments:list', headers: { Authorization: 'Basic ' + config.AUTH_KEY, 'Content-Type': 'text/plain' }, data: JSON.stringify(body) });
    const data = response.data;
    const appointments = data.appointments || [];
    allAppointments = allAppointments.concat(appointments);
    const next = (data.pagination && data.pagination.nextPageToken) || data.nextPageToken || null;
    if (next && next !== pageToken && appointments.length > 0) { pageToken = next; } else { hasMore = false; }
  }
  return allAppointments;
}

async function fetchAppointmentsForLocation(businessId, fileName) {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - config.DOG_CHECKED_BEFORE * 60 * 60 * 1000).toISOString();
    const end = now.toISOString();
    const baseBody = { companyId: config.COMPANY_ID, businessIds: [businessId], filter: { checkOutTime: { startTime: start, endTime: end }, statuses: ['FINISHED'] } };
    const appointments = await fetchAllAppointmentPages(baseBody);
    let dogs = [];
    for (const appointment of appointments) {
      const checkOutTime = appointment.checkOutTime;
      const ownerLastName = '';
      for (const detail of (appointment.petServiceDetails || [])) {
        const pet = detail.pet || {};
        dogs.push({
          name: pet.name || 'Unknown',
          imageUrl: extractPetPhoto(detail),
          ownerLastName: ownerLastName,
          checkOutTime: checkOutTime,
          appointmentId: appointment.id,
          customerId: appointment.customerId,
          serviceItemType: (detail.serviceDetails && detail.serviceDetails[0] ? detail.serviceDetails[0].serviceItemType : '') || '',
          serviceName: extractServiceName(detail),
          lodgingLocation: extractLodgingLocation(detail),
          breed: extractBreed(detail)
        });
      }
    }
    dogs.sort(function(a, b) { return new Date(b.checkOutTime) - new Date(a.checkOutTime); });
    const locationKey = BUSINESS_ID_TO_LOCATION[businessId];
    const enrichedDogs = locationKey ? enrichFromCheckins(dogs, locationKey) : dogs;
    fs.writeFileSync(path.join(__dirname, fileName), JSON.stringify(enrichedDogs, null, 2));
    console.log(' Updated ' + fileName + ' with ' + dogs.length + ' entries.');
  } catch (err) { console.error(' Failed to fetch appointments for ' + fileName + ':', (err.response && err.response.data) || err.message); }
}

async function fetchCheckinsForLocation(businessId, fileName) {
  try {
    const now = new Date();
    const windowHours = Math.min(config.DOG_CHECKED_BEFORE || 6, 6);
    const start = new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();
    const end = now.toISOString();
    const baseBody = { companyId: config.COMPANY_ID, businessIds: [businessId], filter: { statuses: ['CHECKED_IN'] } };
    const appointments = await fetchAllAppointmentPages(baseBody);
    let dogs = [];
    for (const appointment of appointments) {
      let checkInTime = appointment.checkInTime;
      if (!checkInTime) checkInTime = new Date().toISOString();
      const ownerLastName = '';
      for (const detail of (appointment.petServiceDetails || [])) {
        const pet = detail.pet || {};
        dogs.push({
          name: pet.name || 'Unknown',
          imageUrl: extractPetPhoto(detail),
          ownerLastName: ownerLastName,
          checkInTime: checkInTime,
          appointmentId: appointment.id,
          serviceItemType: (detail.serviceDetails && detail.serviceDetails[0] ? detail.serviceDetails[0].serviceItemType : '') || '',
          serviceName: extractServiceName(detail),
          lodgingLocation: extractLodgingLocation(detail),
          breed: extractBreed(detail)
        });
      }
    }
    dogs.sort(function(a, b) { return new Date(b.checkInTime) - new Date(a.checkInTime); });
    fs.writeFileSync(path.join(__dirname, fileName), JSON.stringify(dogs, null, 2));
    console.log(' Updated ' + fileName + ' with ' + dogs.length + ' entries.');
  } catch (err) { console.error(' Failed to fetch check-ins for ' + fileName + ':', (err.response && err.response.data) || err.message); }
}

async function fetchAllLocations() {
  await fetchAppointmentsForLocation(config.BUSINESS_ID, 'dogs.json');
  await fetchCheckinsForLocation(config.BUSINESS_ID, 'checkins.json');
  for (const [key, location] of Object.entries(LOCATIONS)) {
    await fetchAppointmentsForLocation(location.id, 'dogs-' + key + '.json');
    await fetchCheckinsForLocation(location.id, 'checkins-' + key + '.json');
  }
}

function cleanupStaleEntries() {
  const cutoff = new Date(Date.now() - config.DOG_CHECKED_BEFORE * 60 * 60 * 1000);
  const locKeys = Object.keys(LOCATIONS);
  const files = [
    { name: 'dogs.json', timeField: 'checkOutTime' },
    { name: 'checkins.json', timeField: 'checkInTime' },
  ].concat(
    locKeys.map(function(k) { return { name: 'dogs-' + k + '.json', timeField: 'checkOutTime' }; }),
    locKeys.map(function(k) { return { name: 'checkins-' + k + '.json', timeField: 'checkInTime' }; })
  );
  for (const f of files) {
    const filePath = path.join(__dirname, f.name);
    try {
      const dogs = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const filtered = dogs.filter(function(d) { return new Date(d[f.timeField]) > cutoff; });
      if (filtered.length !== dogs.length) { fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2)); }
    } catch (e) {}
  }
}

const mode = config.WEBHOOK_MODE;
let _isPolling = false;
async function fetchAllLocationsGuarded() {
  if (_isPolling) { console.log(' Skipping poll: previous run still in progress'); return; }
  _isPolling = true;
  try { await fetchAllLocations(); } finally { _isPolling = false; }
}

setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [loc, set] of dismissedStore) {
    const ts = getDismissedTimestamps(loc);
    for (const id of [...set]) {
      if ((ts.get(id) || 0) < cutoff) { set.delete(id); ts.delete(id); }
    }
  }
  // Also expire manual queue entries older than 30 min (safety net if real checkout never fires)
  const manualCutoff = Date.now() - 30 * 60 * 1000;
  for (const [loc, arr] of manualCheckouts) {
    const filtered = arr.filter(function(d){ return new Date(d.checkOutTime).getTime() >= manualCutoff; });
    if (filtered.length !== arr.length) manualCheckouts.set(loc, filtered);
  }
}, 60 * 60 * 1000);

if (mode === 'poll' || mode === 'hybrid') {
  setInterval(fetchAllLocationsGuarded, config.POLL_INTERVAL_MS);
  fetchAllLocationsGuarded();
  console.log(' Polling active (every ' + (config.POLL_INTERVAL_MS / 1000) + 's)');
}
if (mode === 'webhook') {
  fetchAllLocations();
  console.log(' Webhook-only mode: initial seed complete, polling disabled');
}
if (mode === 'hybrid' || mode === 'webhook') {
  setInterval(cleanupStaleEntries, config.CLEANUP_INTERVAL_MS);
}

// Debug: read stored checkin/dog JSON files and show all service fields
app.get('/debug-files', (req, res) => {
  const results = {};
  const files = ['checkins.json', 'dogs.json'];
  for (const loc of Object.keys(LOCATIONS)) {
    files.push('checkins-' + loc + '.json');
    files.push('dogs-' + loc + '.json');
  }
  files.forEach(f => {
    const fp = path.join(__dirname, f);
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      results[f] = data.map(d => ({ name: d.name, serviceItemType: d.serviceItemType, serviceName: d.serviceName, lodgingLocation: d.lodgingLocation }));
    } catch(e) { results[f] = 'error: ' + e.message; }
  });
  res.json(results);
});

// Debug: dump raw MoeGo API response for checked-in appointments
app.get('/debug-client', async (req, res) => {
  const customerId = req.query.customerId;
  try {
    const r = await axios.request({
      method: 'post',
      url: 'https://openapi.moego.pet/v1/customers:list',
      headers: { Authorization: 'Basic ' + config.AUTH_KEY, 'Content-Type': 'application/json' },
      data: JSON.stringify({ companyId: config.COMPANY_ID, pagination: { pageSize: 5, pageToken: '1' }, filter: { ids: [customerId] } })
    });
    res.json({ raw: r.data });
  } catch (err) {
    res.json({ error: (err.response && err.response.data) || err.message, status: err.response && err.response.status });
  }
});

app.get('/debug-raw', async (req, res) => {
  try {
    const r = await axios.request({
      method: 'post',
      url: 'https://openapi.moego.pet/v1/appointments:list',
      headers: { Authorization: 'Basic ' + config.AUTH_KEY, 'Content-Type': 'text/plain' },
      data: JSON.stringify({
        companyId: config.COMPANY_ID,
        businessIds: [config.BUSINESS_ID],
        pagination: { pageSize: 50, pageToken: '1' },
        filter: { statuses: ['CHECKED_IN'] }
      })
    });
    // Return a summary focusing on lodging fields
    const summary = (r.data.appointments || []).map(appt => ({
      id: appt.id,
      pets: (appt.petServiceDetails || []).map(d => ({
        pet: d.pet && d.pet.name,
        serviceDetails: (d.serviceDetails || []).map(sd => ({
          name: sd.name,
          serviceItemType: sd.serviceItemType,
          lodgingId: sd.lodgingId,
          lodgingUnitName: sd.lodgingUnitName,
          lodgingTypeName: sd.lodgingTypeName,
          serviceType: sd.serviceType,
        }))
      }))
    }));
    res.json({ total: summary.length, appointments: summary });
  } catch (err) { res.json({ error: (err.response && err.response.data) || err.message }); }
});

app.listen(config.PORT, function() {
  console.log(' Server running at http://localhost:' + config.PORT + ' [mode: ' + mode + ']');
  console.log(' Health check: http://localhost:' + config.PORT + '/health');
  console.log(' Dogs endpoint: http://localhost:' + config.PORT + '/dogs');
  console.log(' Check-ins endpoint: http://localhost:' + config.PORT + '/checkins');
  console.log(' Dismissed endpoint: http://localhost:' + config.PORT + '/dismissed');
  if (mode !== 'poll') console.log(' Webhook endpoint: http://localhost:' + config.PORT + '/webhook');
});
