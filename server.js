const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
const config = require('./config');

// Cache to avoid repeated client lookups
const clientCache = new Map();

// Enable CORS
function buildCorsOrigins(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed || trimmed === '*') return '*';
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}
const corsOrigins = buildCorsOrigins(config.CORS_ORIGINS);
app.use(cors({ origin: corsOrigins, credentials: corsOrigins !== '*' }));
app.use('/webhook', express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf-8'); } }));
app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime(), webhookMode: config.WEBHOOK_MODE });
});

const LOCATIONS = {};
for (const loc of config.LOCATIONS) {
    LOCATIONS[loc.slug] = { id: loc.id, name: loc.name };
}
const BUSINESS_ID_TO_LOCATION = {};
for (const [key, loc] of Object.entries(LOCATIONS)) {
    BUSINESS_ID_TO_LOCATION[loc.id] = key;
}

// Service/reservation name extractor
function extractServiceName(detail) {
    const sd = (detail?.serviceDetails && detail.serviceDetails[0]) || {};
    const candidates = [
          sd.serviceName, sd.name, sd.service?.name, sd.service?.serviceName,
          sd.displayName, detail?.service?.name, detail?.service?.serviceName,
          detail?.serviceName, detail?.name,
        ];
    for (const c of candidates) {
          if (!c) continue;
      const s = String(c).trim();
          if (s) return s;
    }
    return '';
}

// Async client name lookup with in-memory cache
async function fetchClientLastName(customerId) {
    if (!customerId) return '';
    if (clientCache.has(customerId)) return clientCache.get(customerId);
    try {
          const r = await axios.request({
                  method: 'post',
                  url: 'https://openapi.moego.pet/v1/clients:list',
                  headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
                  data: JSON.stringify({
                            companyId: config.COMPANY_ID,
                            pagination: { pageSize: 1, pageToken: '1' },
                            filter: { ids: [customerId] }
      })
          });
          const clients = (r.data && r.data.clients) || [];
          const client = clients[0] || {};
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

// Pet photo extractor
function extractPetPhoto(detail) {
    const pet = detail?.pet || {};
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

// Owner last-name extractor
function extractOwnerLastName(appointment, detail) {
            const pet = detail?.pet || {};
    const candidates = [
          appointment?.customer?.lastName, appointment?.customer?.familyName,
          appointment?.customer?.name, appointment?.customer?.fullName,
          appointment?.owner?.lastName, appointment?.owner?.name,
          appointment?.petOwner?.lastName, appointment?.petOwner?.name,
          pet?.owner?.lastName, pet?.owner?.name,
          pet?.customer?.lastName, pet?.customer?.name,
          detail?.customer?.lastName, detail?.customer?.name,
        ];
    for (const c of candidates) {
          if (!c) continue;
          const s = String(c).trim();
          if (!s) continue;
          const parts = s.split(/\s+/);
          return parts[parts.length - 1];
    }
    return '';
}

// Checkouts
app.get('/dogs', (req, res) => {
    const location = req.query.location || 'default';
    const filePath = location === 'default'
      ? path.join(__dirname, 'dogs.json')
          : path.join(__dirname, `dogs-${location}.json`);
    if (fs.existsSync(filePath)) {
          res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } else {
          res.json([]);
    }
});

// Check-ins
app.get('/checkins', (req, res) => {
    const location = req.query.location || 'default';
    const filePath = location === 'default'
      ? path.join(__dirname, 'checkins.json')
          : path.join(__dirname, `checkins-${location}.json`);
    if (fs.existsSync(filePath)) {
          res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } else {
          res.json([]);
    }
});

app.get('/locations', (req, res) => {
    res.json({ businessName: config.BUSINESS_NAME, locations: LOCATIONS });
});

// Debug endpoints
app.get('/debug-moego', async (req, res) => {
    try {
          const r = await axios.request({
                  method: 'post',
                  url: 'https://openapi.moego.pet/v1/companies:list',
                  headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
                  data: JSON.stringify({ pagination: { pageSize: 10, pageToken: '1' } })
          });
          res.json({ companies: r.data });
    } catch (err) {
          res.json({ error: err.response?.data || err.message });
    }
});

app.get('/debug-businesses', async (req, res) => {
    const companyId = req.query.companyId;
    try {
          const r = await axios.request({
                  method: 'post',
                  url: 'https://openapi.moego.pet/v1/businesses:list',
                  headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
                  data: JSON.stringify({ pagination: { pageSize: 10, pageToken: '1' }, companyId })
          });
          res.json({ businesses: r.data });
    } catch (err) {
          res.json({ error: err.response?.data || err.message });
    }
});

app.get('/debug-appts', async (req, res) => {
    const { companyId, businessId } = req.query;
    try {
          const r = await axios.request({
                  method: 'post',
                  url: 'https://openapi.moego.pet/v1/appointments:list',
                  headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
                  data: JSON.stringify({
                            pagination: { pageSize: 5, pageToken: '1' },
                            companyId, businessIds: [businessId],
                            filter: { statuses: ['FINISHED'] }
                  })
          });
          res.json(r.data);
    } catch (err) {
          res.json({ error: err.response?.data || err.message });
    }
});

app.get('/debug-checkins', async (req, res) => {
    const { companyId, businessId } = req.query;
    try {
          const r = await axios.request({
                  method: 'post',
                  url: 'https://openapi.moego.pet/v1/appointments:list',
                  headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
                  data: JSON.stringify({
                            pagination: { pageSize: 5, pageToken: '1' },
                            companyId, businessIds: [businessId],
                            filter: { statuses: ['IN_PROGRESS'] }
                  })
          });
          res.json(r.data);
    } catch (err) {
          res.json({ error: err.response?.data || err.message });
    }
});

app.get('/debug-client', async (req, res) => {
    try {
          const results = {};
          try {
                  const r = await axios.request({
                            method: 'post',
                            url: 'https://openapi.moego.pet/v2/clients:list',
                            headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
                            data: JSON.stringify({ companyId: config.COMPANY_ID, pagination: { pageSize: 1, pageToken: '1' } })
                  });
                  results.v2list = r.data;
          } catch (e) { results.v2listErr = e.message + ' s:' + (e.response && e.response.status); }
          try {
                  const r = await axios.request({
                            method: 'post',
                            url: 'https://openapi.moego.pet/v1/appointments:list',
                            headers: { Authorization: `Basic ${config.AUTH_KEY}`, 'Content-Type': 'text/plain' },
                            data: JSON.
