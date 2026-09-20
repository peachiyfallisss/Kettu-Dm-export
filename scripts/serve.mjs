import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

const port = Number(process.env.PORT || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const prefix = '/' + randomBytes(16).toString('hex') + '/';
// Serve exactly two plugin files. Never serve the repository, credentials,
// export files, directory listings, or arbitrary filesystem paths.
const bundle = await readFile(new URL('../dist/index.js', import.meta.url));
const manifest = await readFile(new URL('../dist/manifest.json', import.meta.url));
const server = createServer((req, res) => {
  const files = new Map([
    [prefix + 'manifest.json', [manifest, 'application/json']],
    [prefix + 'index.js', [bundle, 'application/javascript']]
  ]);
  const entry = files.get(req.url);
  if (!entry || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': entry[1] + '; charset=utf-8', 'Content-Length': entry[0].length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : entry[0]);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '0.0.0.0', () => {
  console.log('DM Export install server. Stop with Ctrl+C after installation.');
  console.log('On the same phone (Termux):');
  console.log(`http://127.0.0.1:${port}${prefix}`);
  let addresses = [];
  try { addresses = Object.values(networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal); }
  catch { console.log('Automatic LAN address lookup is unavailable on this device. For another device, replace 127.0.0.1 with this computer\'s Wi-Fi IPv4 address.'); }
  for (const n of addresses) console.log(`On the same Wi-Fi: http://${n.address}:${port}${prefix}`);
  console.log('Kettu → Plugins → Add plugin: paste one of these full URLs, including the final slash.');
  console.log('This serves plugin code only. DM exports stay on your phone.');
});
