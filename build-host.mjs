// Build the single-file host bundle: concatenate host modules so a versioned
// entry URL can bust the ESM cache without nested-module staleness.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error('Invalid build version');
const parts = ['board-model.js', 'schema.mjs', 'store.mjs', 'service.mjs', 'thread.mjs', 'index.mjs'];
const header = [
  "import fs from 'node:fs';",
  "import fsp from 'node:fs/promises';",
  "import path from 'node:path';",
  "import { createRequire } from 'node:module';",
  "import { pathToFileURL } from 'node:url';",
  "import { isDeepStrictEqual } from 'node:util';",
  '',
].join('\n');

function strip(code) {
  return code
    .replace(/^import\s+(?:[\s\S]*?\s+from\s+)?['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};\s*$/gm, '')
    .replace(/^export\s+(?=async\s+function|function|class|const|let|var)/gm, '')
    .trim();
}

const bodies = parts.map((name) => strip(fs.readFileSync(path.join(dir, name), 'utf8')));
const bundle = header + bodies.join('\n\n') + '\nexport { name, inject, apply };\n';
const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: bundle, encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(syntax.stderr || 'Host syntax check failed');
fs.writeFileSync(path.join(dir, 'host.mjs'), bundle);
const entry = `// Generated loader entry; restart DSH after replacing a release.\nexport { name, inject, apply } from './host.mjs?pb=${version}';\n`;
fs.writeFileSync(path.join(dir, 'entry.mjs'), entry);
console.error(JSON.stringify({ version, hostBytes: Buffer.byteLength(bundle), entry: 'entry.mjs' }));
