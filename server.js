// Down Dog Lodge - Digital Whiteboard
// Gingr API backend (uses back_of_house endpoint - matches native Gingr whiteboard)

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// ---------- Config (from env vars on Railway) ----------
const PORT = process.env.PORT || 3000;
const GINGR_SUBDOMAIN = process.env.GINGR_SUBDOMAIN || 'ddl';
const GINGR_API_KEY = process.env.GINGR_API_KEY;
const GINGR_WHITEBOARD_KEY = process.env.GINGR_WHITEBOARD_KEY;
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Down Dog Lodge';

const LOCATIONS = {
  'el-segundo': { name: 'El Segundo' }
};

// Cache: hold Gingr responses for 4 sec
const CACHE_TTL_MS = 4 * 1000;
const cache = new Map();

// ---------- Middleware ----------
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public', { index: 'dashboard.html' }));

// ---------- Helpers ----------
function pick(obj) {
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return '';
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

function mapServiceType(typeStr) {
  if (!typeStr) return '';
  const t = String(typeStr).trim().toLowerCase();
  if (t.includes('board')) return 'BOARDING';
  if (t.includes('daycare') || t.includes('day care')) return 'DAYCARE';
  if (t.includes('eval') || t.includes('temperament')) return 'EVALUATION';
  if (t.includes('groom')) return 'GROOMING';
  if (t.includes('bath')) return 'BATH';
  if (t.includes('train')) return 'TRAINING';
  return '';
}

function transformItem(item, timeField) {
  const animal = item.animal || {};
  const owner = item.owner || {};

  const serviceTypeRaw = pick(item, 'reservation_type_name', 'service_name', 'type') ||
    (item.reservation_type && item.reservation_type.type) || '';

  const lodgingLoc = pick(item, 'lodging_name', 'lodging_location', 'kennel_name', 'pen', 'lodging') ||
    (item.lodging && (item.lodging.name || item.lodging.label)) || '';

  return {
    appointmentId: String(pick(item, 'reservation_id', 'id', 'appointment_id') || ''),
    name: stripHtml(pick(animal, 'name', 'first_name') || pick(item, 'animal_name', 'pet_name', 'name', 'first_name') || 'Unknown'),
    ownerLastName: stripHtml(pick(owner, 'last_name', 'lastname') || pick(item, 'owner_last_name', 'last_name') || ''),
    imageUrl: pick(animal, 'image', 'image_url', 'photo', 'photo_url') || pick(item, 'animal_image', 'image', 'image_url', 'photo') || '',
    serviceName: String(serviceTypeRaw).trim(),
    serviceItemType: mapServiceType(serviceTypeRaw),
    breed: stripHtml(pick(animal, 'breed') || pick(item, 'animal_breed', 'breed') || ''),
    customerId: String(pick(owner, 'id', 'customer_id') || pick(item, 'customer_id', 'owner_id') || ''),
    lodgingLocation: stripHtml(lodgingLoc),
    [timeField]: pick(item, 'check_in_time', 'time_in', 'checkin_time', 'check_in_date', 'check_out_time', 'time_out', 'checkout_time', 'check_out_date', 'time') || ''
  };
}

async function callBackOfHouse() {
  if (!GINGR_WHITEBOARD_KEY) throw new Error('GINGR_WHITEBOARD_KEY not set');
  const cacheKey = 'back_of_house';
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.data;

  const url = 'https://' + GINGR_SUBDOMAIN + '.gingrapp.com/api/v1/back_of_house';
  const response = await axios.get(url, {
    params: { key: GINGR_WHITEBOARD_KEY, location_id: 1, mins_future: 0, full_day: false },
    timeout: 10000
  });
  const raw = response.data;
  if (raw.error) throw new Error('Gingr API error: ' + JSON.stringify(raw));
  const data = raw.data || { checking_in: [], checking_out: [] };
  cache.set(cacheKey, { ts: now, data });
  return data;
}

// ---------- Routes ----------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    apiKeyConfigured: !!GINGR_API_KEY,
    whiteboardKeyConfigured: !!GINGR_WHITEBOARD_KEY,
    subdomain: GINGR_SUBDOMAIN
  });
});

app.get('/locations', (req, res) => {
  res.json({ businessName: BUSINESS_NAME, locations: LOCATIONS });
});

app.get('/checkins', async (req, res) => {
  try {
    const data = await callBackOfHouse();
    const items = (data.checking_in || []).map(item => transformItem(item, 'checkInTime'));
    res.json(items);
  } catch (err) {
    console.error('checkins error:', err.message);
    res.status(500).json({ error: err.message, dogs: [] });
  }
});

app.get('/dogs', async (req, res) => {
  try {
    const data = await callBackOfHouse();
    const items = (data.checking_out || []).map(item => transformItem(item, 'checkOutTime'));
    res.json(items);
  } catch (err) {
    console.error('dogs error:', err.message);
    res.status(500).json({ error: err.message, dogs: [] });
  }
});

app.get('/in-house', async (req, res) => {
  try {
    const data = await callBackOfHouse();
    const all = [
      ...(data.checking_in || []).map(item => transformItem(item, 'checkInTime')),
      ...(data.checking_out || []).map(item => transformItem(item, 'checkInTime'))
    ];
    const seen = new Set();
    const unique = [];
    for (const d of all) {
      if (d.appointmentId && !seen.has(d.appointmentId)) {
        seen.add(d.appointmentId);
        unique.push(d);
      }
    }
    unique.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json(unique);
  } catch (err) {
    console.error('in-house error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug: see raw back_of_house response
app.get('/debug-bof', async (req, res) => {
  try {
    const data = await callBackOfHouse();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log('Down Dog Lodge whiteboard running on port ' + PORT);
  console.log('Gingr subdomain: ' + GINGR_SUBDOMAIN + '.gingrapp.com');
  console.log('Whiteboard key configured: ' + !!GINGR_WHITEBOARD_KEY);
});
