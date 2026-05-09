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
const CACHE_TTL_MS = 1 * 1000;
const cache = new Map();

// Animal cache (image lookups) - longer TTL since images don't change often
const ANIMAL_CACHE_TTL_MS = 5 * 60 * 1000;
let allAnimalsCache = null;
let allAnimalsCacheTs = 0;

// ---------- Middleware ----------
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public', { index: 'dashboard.html' }));

// ---------- Helpers ----------
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

function mapServiceType(typeStr) {
  if (!typeStr) return '';
  const t = String(typeStr).trim().toLowerCase();
  if (t.includes('daycare') || t.includes('day care')) return 'DAYCARE';
  if (t.includes('board')) return 'BOARDING';
  if (t.includes('eval') || t.includes('temperament')) return 'EVALUATION';
  if (t.includes('groom')) return 'GROOMING';
  if (t.includes('bath')) return 'BATH';
  if (t.includes('train')) return 'TRAINING';
  return '';
}

function stampToIso(stamp) {
  if (!stamp) return '';
  const n = parseInt(stamp, 10);
  if (!n || isNaN(n)) return '';
  // Gingr stamps are seconds; multiply by 1000 for ms
  return new Date(n * 1000).toISOString();
}

function transformItem(item, timeField) {
  const checkInIso = stampToIso(item.check_in_stamp);
  const checkOutIso = stampToIso(item.check_out_stamp);

  return {
    appointmentId: String(item.id || item.reservation_id || ''),
    name: stripHtml(item.a_first || item.animal_name || item.name || 'Unknown'),
    ownerLastName: stripHtml(item.o_last || item.owner_last_name || ''),
    imageUrl: '', // populated by enrichment
    serviceName: stripHtml(item.type || ''),
    serviceItemType: mapServiceType(item.type),
    breed: stripHtml(item.breed_name || item.breed || ''),
    customerId: String(item.owner_id || ''),
    lodgingLocation: stripHtml(item.run_name || item.area_name || ''),
    statusString: item.status_string || '',
    [timeField]: timeField === 'checkInTime' ? checkInIso : (checkOutIso || checkInIso),
    _animalId: String(item.animal_id || '')
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

// Fetch all animals once (cached for 5 min) for image lookup
async function fetchAllAnimals() {
  if (allAnimalsCache && Date.now() - allAnimalsCacheTs < ANIMAL_CACHE_TTL_MS) return allAnimalsCache;
  if (!GINGR_API_KEY) return [];
  try {
    const url = 'https://' + GINGR_SUBDOMAIN + '.gingrapp.com/api/v1/animals';
    const formBody = new URLSearchParams({ key: GINGR_API_KEY }).toString();
    const r = await axios.post(url, formBody, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });
    const raw = r.data;
    if (raw.error) return [];
    const arr = raw.data ? Object.values(raw.data) : [];
    allAnimalsCache = arr;
    allAnimalsCacheTs = Date.now();
    return arr;
  } catch (err) {
    console.error('fetchAllAnimals error:', err.message);
    return [];
  }
}

async function enrichWithImages(items) {
  const all = await fetchAllAnimals();
  const byId = {};
  for (const a of all) {
    if (a && a.id) byId[String(a.id)] = a;
  }
  return items.map(item => {
    const fa = byId[item._animalId];
    if (fa) {
      item.imageUrl = fa.image || fa.image_url || fa.photo || fa.photo_url || '';
    }
    delete item._animalId;
    return item;
  });
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
    const enriched = await enrichWithImages(items);
    res.json(enriched);
  } catch (err) {
    console.error('checkins error:', err.message);
    res.status(500).json({ error: err.message, dogs: [] });
  }
});

app.get('/dogs', async (req, res) => {
  try {
    const data = await callBackOfHouse();
    const items = (data.checking_out || []).map(item => transformItem(item, 'checkOutTime'));
    const enriched = await enrichWithImages(items);
    res.json(enriched);
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
    const enriched = await enrichWithImages(unique);
    enriched.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json(enriched);
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
