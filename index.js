require('./src/timezone');
require('dotenv').config();
const { connectDB } = require('./src/db');
const { syncOnce } = require('./src/sync');

async function main() {
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
