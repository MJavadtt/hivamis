import { readFileSync } from 'node:fs';
import path from 'node:path';

// Load .env.test before any module reads process.env (env.ts validates at import time).
const envPath = path.resolve(import.meta.dirname, '../.env.test');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
