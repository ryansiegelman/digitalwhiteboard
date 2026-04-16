const DEFAULT_LOCATIONS = [
  { slug: 'el-segundo', id: process.env.BUSINESS_ID || 'bizypEi', name: 'El Segundo' }
];

function parseLocations() {
  const raw = process.env.LOCATIONS_JSON;
  if (!raw) return DEFAULT_LOCATIONS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch (e) {
    console.warn('Warning: LOCATIONS_JSON is invalid JSON, using defaults.');
  }
  return DEFAULT_LOCATIONS;
}

module.exports = {
  AUTH_KEY: process.env.AUTH_KEY || 'ZTBiYjdkYTItNjYxYy00OTdiLTk2ZjgtM2ZjMzk1ZWI3MzU2',
  COMPANY_ID: process.env.COMPANY_ID || 'copnLAK',
  BUSINESS_ID: process.env.BUSINESS_ID || 'bizypEi',
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS) || 10000,
  DOG_CHECKED_BEFORE: parseFloat(process.env.DOG_CHECKED_BEFORE) || 36,
  PORT: parseInt(process.env.PORT) || 3000,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  WEBHOOK_MODE: process.env.WEBHOOK_MODE || 'poll',
  CLEANUP_INTERVAL_MS: parseInt(process.env.CLEANUP_INTERVAL_MS) || 300000,
  BASE_URL: process.env.BASE_URL || '',
  BUSINESS_NAME: process.env.BUSINESS_NAME || 'Down Dog Lodge',
  LOCATIONS: parseLocations(),
  CORS_ORIGINS: process.env.CORS_ORIGINS || '*',
};
