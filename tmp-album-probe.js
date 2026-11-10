require('dotenv').config();
const { createLordSource } = require('./src/roster/lord');

(async () => {
  const source = createLordSource({ tag: 'ALBUM-PROBE', stripe: 1 });
  try {
    const page = await source.fetch('25615899', '2026-11-05');
    console.log('fetch:', page.status, page.ok, page.reason || '');
    if (!page.ok) return;
    const data = await source.read(page.html);
    console.log('name:', data.title);
    console.log('nameHistory:', JSON.stringify(data.nameHistory));
    console.log('serverHistory:', JSON.stringify(data.serverHistory));
    console.log('alliance:', data.alliance);
    console.log('albums:', JSON.stringify(data.albums, null, 2));
  } finally {
    await source.close();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
