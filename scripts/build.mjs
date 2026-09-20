import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['core', 'mobile', 'plugin'];
const bodies = await Promise.all(files.map(async name => {
  const source = await readFile(path.join(root, 'src', name + '.mjs'), 'utf8');
  // These files intentionally have no imports. Tests import the pure core;
  // Kettu receives one expression whose value is the plugin lifecycle object.
  if (/^import\s/m.test(source)) throw new Error('Runtime files must be dependency-free');
  return source.replace(/^export (?=(async )?(function|class|const)\b)/gm, '');
}));
const bundle = '(() => {\n"use strict";\n' + bodies.join('\n') + '\nreturn createPlugin(vendetta);\n})()\n';
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
manifest.hash = createHash('sha256').update(bundle).digest('hex');
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/index.js'), bundle);
await writeFile(path.join(root, 'dist/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${Buffer.byteLength(bundle)} bytes; SHA-256 ${manifest.hash}`);
