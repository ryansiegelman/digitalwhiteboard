// Down Dog Lodge - Digital Whiteboard
// Gingr API backend (replaces Moego version)

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// ---------- Config (from env vars on Railway) ----------
const PORT = process.env.PORT || 3000;
const GINGR_SUBDOMAIN = process.env.GINGR_SUBDOMAIN || 'ddl';
const GINGR_API_KEY = process.env.GINGR_API_KEY;
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Down Dog Lodge';

// Multi-location support: defaults to single 'el-segundo' location.
// Future locations can be added here without touching the rest of the code.
const LOCATIONS = {
  'el-segundo': { name: 'El Segundo' }
};

// Visible window: only show dogs checked in/out within last 10 min
const VISIBLE_WINDOW_MS = 10 * 60 * 1000;

// Cache: hold Gingr responses for 4 sec to avoid hammering the API
// (frontend polls every 5 sec, so this gives us breathing room)
const CACHE_TTL_MS = 4 * 1000;
const cache = new Map();

// ---------- Middleware ----------
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public', { index: 'dashboard.html' }));

// ---------- Helpers ----------

// Map Gingr reservation_type.type to a serviceItemType the frontend understands.
// Frontend pill colors key off these values.
function mapServiceType(typeStr) {
  if (!typeStr) return '';
  const t = String(typeStr).trim().toLowerCase();
  if (t.includes('board')) return 'BOARDING';
  if (t.includes('daycare') || t.includes('day care')) return 'DAYCARE';
  if (t.includes('eval') || t.includes('temperament')) return 'EVALUATION';
  if (t.includes('groom')) return 'GROOMING';
  if (t.includes('bath')) return 'BATH';
  if (t.includes('train')) return 'TRAINING';
  return ''; // unknown type, frontend will show generic pill
}

// Try every common photo field on a Gingr animal object
function extractAnimalPhoto(animal) {
  if (!animal) return '';
  const candidates = [
    animal.image, animal.image_url, animal.photo, animal.photo_url,
    animal.avatar, animal.avatar_url, animal.picture, animal.picture_url
  ];
  for (const c of candidates) {
    if (c && typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
  }
  return '';
}

// Strip HTML tags from Gingr-formatted notes (they wrap everything in <p>)
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

// Transform a Gingr reservation into the shape the frontend expects
function transformReservation(r, timeField) {
  const animal = r.animal || {};
  const owner = r.owner || {};
  const serviceTypeRaw = (r.reservation_type && r.reservation_type.type) || '';

  return {
    appointmentId: String(r.reservation_id || ''),
    name: (animal.name || 'Unknown').trim(),
    ownerLastName: (owner.last_name || '').trim(),
    imageUrl: extractAnimalPhoto(r._fullAnimal || animal), lodgingLocation: extractLodging(r._fullAnimal, r),
    serviceName: serviceTypeRaw.trim(),
    serviceItemType: mapServiceType(serviceTypeRaw),
    breed: (animal.breed || '').trim(),
    customerId: String(owner.id || ''),
    [timeField]: r[timeField === 'checkInTime' ? 'check_in_date' : 'check_out_date'] || ''
  };
}

// ---------- Gingr API call (cached) ----------
async function callGingr(params) {
  if (!GINGR_API_KEY) throw new Error('GINGR_API_KEY not set');
  const cacheKey = JSON.stringify(params);
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.data;

  const url = `https://${GINGR_SUBDOMAIN}.gingrapp.com/api/v1/reservations`;
  const formBody = new URLSearchParams({ key: GINGR_API_KEY, ...params }).toString();

  const response = await axios.post(url, formBody, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });

  const raw = response.data;
  if (raw.error) throw new Error('Gingr API error: ' + JSON.stringify(raw));

  // Gingr returns { error: false, data: { "id1": {...}, "id2": {...} } }
  // Convert to array
  const arr = raw.data ? Object.values(raw.data) : [];
  cache.set(cacheKey, { ts: now, data: arr });
  return arr;
}

// ---------- Routes ----------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    apiKeyConfigured: !!GINGR_API_KEY,
    subdomain: GINGR_SUBDOMAIN
  });
});

app.get('/locations', (req, res) => {
  res.json({ businessName: BUSINESS_NAME, locations: LOCATIONS });
});

// Currently checked-in dogs whose check_in_date is within last 10 min
app.get('/checkins', async (req, res) => {
  try {
    const _r = await callGingr({ checked_in: 'true' }); const reservations = await enrichReservations(_r);
    const cutoff = Date.now() - VISIBLE_WINDOW_MS;

    const dogs = reservations
      .filter(r => {
        if (!r.check_in_date) return false;
        return new Date(r.check_in_date).getTime() >= cutoff;
      })
      .map(r => transformReservation(r, 'checkInTime'))
      .sort((a, b) => new Date(b.checkInTime) - new Date(a.checkInTime));

    res.json(dogs);
  } catch (err) {
    console.error('checkins error:', err.message);
    res.status(500).json({ error: err.message, dogs: [] });
  }
});

// Recently checked-out dogs: pull today's reservations, filter by check_out_date in last 10 min
app.get('/dogs', async (req, res) => {
  try {
    // Use today's date for the date range (Gingr requires it when checked_in=false)
    const today = new Date().toISOString().split('T')[0];
    const _r2 = await callGingr({ start_date: today, end_date: today }); const reservations = await enrichReservations(_r2);
    const cutoff = Date.now() - VISIBLE_WINDOW_MS;

    const dogs = reservations
      .filter(r => {
        if (!r.check_out_date) return false;
        if (r.cancelled_date) return false; // skip cancelled
        return new Date(r.check_out_date).getTime() >= cutoff;
      })
      .map(r => transformReservation(r, 'checkOutTime'))
      .sort((a, b) => new Date(b.checkOutTime) - new Date(a.checkOutTime));

    res.json(dogs);
  } catch (err) {
    console.error('checkouts error:', err.message);
    res.status(500).json({ error: err.message, dogs: [] });
  }
});

// Debug: see raw Gingr response for currently checked-in
app.get('/debug-gingr', async (req, res) => {
  try {
    const _r = await callGingr({ checked_in: 'true' }); const reservations = await enrichReservations(_r);
    res.json({ count: reservations.length, reservations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: today's reservations (raw)
app.get('/debug-today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const _r2 = await callGingr({ start_date: today, end_date: today }); const reservations = await enrichReservations(_r2);
    res.json({ count: reservations.length, reservations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function extractLodging(a, r) { if (a) { const v = a.lodging || a.kennel || a.lodging_name || a.lodging_location || a.pen || ''; if (v) return String(v).trim(); } if (r && r.lodging) { const v = r.lodging.name || r.lodging.kennel || ''; if (v) return String(v).trim(); } return ''; }
async function fetchAnimalFull(id) { if (!id || !GINGR_API_KEY) return null; const cacheKey = 'animal:' + id; const cached = cache.get(cacheKey); if (cached && Date.now() - cached.ts < 60000) return cached.data; try { const url = `https://${GINGR_SUBDOMAIN}.gingrapp.com/api/v1/animals`; const formBody = new URLSearchParams({ key: GINGR_API_KEY }).toString(); const response = await axios.post(url, formBody, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }); const raw = response.data; if (raw.error) return null; const arr = raw.data ? Object.values(raw.data) : []; const animal = arr.find(a => String(a.id) === String(id)) || null; cache.set(cacheKey, { ts: Date.now(), data: animal }); return animal; } catch (err) { console.error('fetchAnimalFull error:', err.message); return null; } }
async function enrichReservations(reservations) { return Promise.all(reservations.map(async (r) => { const a = await fetchAnimalFull(r.animal && r.animal.id); if (a) r._fullAnimal = a; return r; })); }
app.get('/in-house', async (req, res) => { try { const _r = await callGingr({ checked_in: 'true' }); const reservations = await enrichReservations(_r); const dogs = reservations.filter(r => r.check_in_date && !r.check_out_date).map(r => transformReservation(r, 'checkInTime')).sort((a, b) => (a.name || '').localeCompare(b.name || '')); res.json(dogs); } catch (err) { console.error('in-house error:', err.message); res.status(500).json({ error: err.message }); } });
// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Down Dog Lodge whiteboard running on port ${PORT}`);
  console.log(`Gingr subdomain: ${GINGR_SUBDOMAIN}.gingrapp.com`);
  console.log(`API key configured: ${!!GINGR_API_KEY}`);
});
app.get('/debug-lodging', async (req, res) => { const tries = [['reservations',{checked_in:'true',include_lodging:'true'}],['reservations',{checked_in:'true',expand:'lodging'}],['lodging',{}],['reservations_lodging',{}],['animals_lodging',{}],['lodging_locations',{}],['kennels',{}],['pens',{}],['locations',{}]]; const out = {}; for (const [ep, p] of tries) { try { const url = `https://${GINGR_SUBDOMAIN}.gingrapp.com/api/v1/${ep}`; const formBody = new URLSearchParams({ key: GINGR_API_KEY, ...p }).toString(); const r = await axios.post(url, formBody, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000, validateStatus: () => true }); const raw = r.data; const dataObj = raw && raw.data; const firstKey = dataO
