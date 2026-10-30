require('./src/timezone');
require('dotenv').config();
const { connectDB } = require('./src/db');
const { syncOnce } = require('./src/sync');
const { configuredDevices } = require('./src/device');

async function main() {
  // Render may still use the legacy `node index.js` start command. In a cloud
  // web service there is no office-LAN device to poll, so run the dashboard
  // instead of exiting with "No device configured".
  if (!configuredDevices().length && process.env.RENDER) {
    console.log('[startup] no LAN device configured; starting web service');
    require('./server');
    // Keep the legacy Render start command alive while server.js initializes.
    setInterval(() => {}, 60 * 60 * 1000);
    return;
  }
  await connectDB();

  const watch = process.argv.includes('--watch');
  if (!watch) {
    await syncOnce();
    process.exit(0);
  }

  const intervalMs = Number(process.env.SYNC_INTERVAL_MS || 60000);
  console.log(`[watch] syncing every ${intervalMs}ms - Ctrl+C to stop`);
  await syncOnce().catch((err) => console.error('[sync] failed:', err.message));
  setInterval(() => {
    syncOnce().catch((err) => console.error('[sync] failed:', err.message));
  }, intervalMs);
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
