// Copies non-TypeScript runtime assets into dist after `tsc`.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'src', 'db', 'schema.sql');
const targetDir = path.join(root, 'dist', 'db');
const target = path.join(targetDir, 'schema.sql');

if (!fs.existsSync(source)) {
  console.error(`[copy-assets] missing ${source}`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);
console.log(`[copy-assets] ${path.relative(root, target)}`);
