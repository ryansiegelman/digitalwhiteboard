const axios = require('axios');
const config = require('../config');

const API_BASE = 'https://openapi.moego.pet/v1';
const headers = {
  Authorization: `Basic ${config.AUTH_KEY}`,
  'Content-Type': 'application/json'
};

const command = process.argv[2];
const arg = process.argv[3];

async function createWebhook() {
  if (!config.BASE_URL) {
    console.error('❌ BASE_URL is required. Set it in .env');
    process.exit(1);
  }

  const body = {
    endpointUrl: `${config.BASE_URL}/webhook`,
    eventTypes: ['APPOINTMENT_FINISHED', 'HEALTH_CHECK'],
    isActive: true,
    verifySsl: true
  };

  if (config.WEBHOOK_SECRET) {
    body.secretToken = config.WEBHOOK_SECRET;
  }

  console.log('📤 Registering:', JSON.stringify(body, null, 2));
  const res = await axios.post(`${API_BASE}/webhooks`, body, { headers });

  console.log('✅ Webhook created:');
  console.log(JSON.stringify(res.data, null, 2));
}

async function listWebhooks() {
  const res = await axios.post(`${API_BASE}/webhooks:list`, { pagination: { pageSize: 20, pageToken: '1' } }, { headers });
  console.log('📋 Registered webhooks:');
  console.log(JSON.stringify(res.data, null, 2));
}

async function testWebhook(id) {
  if (!id) {
    console.error('❌ Usage: node scripts/register-webhook.js test <webhook-id>');
    process.exit(1);
  }

  const res = await axios.post(`${API_BASE}/webhooks/${id}/test`, {}, { headers });
  console.log('🧪 Test sent:');
  console.log(JSON.stringify(res.data, null, 2));
}

async function deleteWebhook(id) {
  if (!id) {
    console.error('❌ Usage: node scripts/register-webhook.js delete <webhook-id>');
    process.exit(1);
  }

  const res = await axios.delete(`${API_BASE}/webhooks/${id}`, { headers });
  console.log('🗑️ Webhook deleted:');
  console.log(JSON.stringify(res.data, null, 2));
}

async function main() {
  try {
    switch (command) {
      case 'create':
        await createWebhook();
        break;
      case 'list':
        await listWebhooks();
        break;
      case 'test':
        await testWebhook(arg);
        break;
      case 'delete':
        await deleteWebhook(arg);
        break;
      default:
        console.log('Usage: node scripts/register-webhook.js <command> [args]');
        console.log('');
        console.log('Commands:');
        console.log('  create          Register webhook with MoeGo');
        console.log('  list            List existing webhooks');
        console.log('  test <id>       Send HEALTH_CHECK test');
        console.log('  delete <id>     Remove webhook');
        process.exit(1);
    }
  } catch (err) {
    console.error('❌ Error:', err.response?.data || err.message);
    process.exit(1);
  }
}

main();
