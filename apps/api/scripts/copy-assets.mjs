/**
 * Copy non-TypeScript runtime assets into dist.
 *
 * tsc emits only compiled .ts; anything else in src/ is left behind. The PDF renderer reads its
 * Vazirmatn .woff2 files from disk at request time and base64-embeds them, so without this step
 * every PDF route fails with ENOENT in any compiled deployment — including the Docker image,
 * where the failure is invisible until someone asks for a PDF.
 */
import { cp, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  ['src/pdf/assets', 'dist/pdf/assets'],
];

for (const [from, to] of ASSETS) {
  const src = resolve(root, from);
  try {
    await access(src);
  } catch {
    console.error(`copy-assets: missing ${from}`);
    process.exit(1);
  }
  await cp(src, resolve(root, to), { recursive: true });
  console.log(`copy-assets: ${from} → ${to}`);
}
