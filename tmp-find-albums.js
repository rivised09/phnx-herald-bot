require('dotenv').config();
const r2 = require('./src/roster/r2');

(async () => {
  const keys = (await r2.listKeys('players/')).slice(0, 300);
  let found = 0;
  for (let i = 0; i < keys.length; i += 10) {
    const batch = keys.slice(i, i + 10);
    const files = await Promise.all(batch.map((key) => r2.getJson(key).catch(() => null)));
    for (const file of files) {
      if (!file) continue;
      const date = (file.dates || []).find((d) => file.byDate?.[d]?.albums?.length);
      if (date || file.albums?.length) {
        console.log(file.id, 'date:', date, 'perDate:', date ? file.byDate[date].albums.length : 0, 'top:', file.albums?.length || 0);
        console.log(JSON.stringify(date ? file.byDate[date].albums[0] : file.albums[0]));
        found += 1;
        if (found >= 5) return;
      }
    }
  }
  console.log('done; matches:', found);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
