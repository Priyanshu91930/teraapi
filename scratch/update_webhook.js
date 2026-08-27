import fs from 'node:fs';

// Load env
try {
  const envFile = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch (e) {
  console.log('Error loading .env:', e.message);
}

async function run() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN not found in environment!');
    process.exit(1);
  }

  try {
    // 1. Get webhook info
    console.log('Fetching current webhook info...');
    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const infoData = await infoRes.json();
    console.log('Current Webhook Info:', JSON.stringify(infoData, null, 2));

    let currentUrl = infoData.result?.url;
    if (!currentUrl) {
      console.log('No current webhook URL found. Defaulting to production Vercel Bot URL...');
      currentUrl = 'https://teraapi-seven.vercel.app/bot';
    }

    // 2. Set webhook with allowed_updates
    console.log(`Setting webhook to: ${currentUrl} with allowed_updates...`);
    const allowedUpdates = ["message", "callback_query", "chat_join_request", "chat_member"];
    const setRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentUrl,
        allowed_updates: allowedUpdates
      })
    });
    const setData = await setRes.json();
    console.log('SetWebhook Response:', JSON.stringify(setData, null, 2));

    if (setData.ok) {
      console.log('SUCCESS! Webhook set with allowed_updates successfully.');
    } else {
      console.error('FAILED to set webhook.');
    }
  } catch (err) {
    console.error('An error occurred:', err);
  }
  process.exit(0);
}

run();
