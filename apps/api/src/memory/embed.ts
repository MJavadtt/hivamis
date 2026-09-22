/**
 * Turning text into a vector (roadmap #21).
 *
 * Two embedders, and the search result always says which one produced its numbers:
 *
 *  - **A configured service.** Any OpenAI-shaped `/embeddings` endpoint: a hosted one, or a
 *    local Ollama / LM Studio / vLLM, which is the realistic option for an on-prem Iranian
 *    deployment with no egress. Set EMBEDDING_URL (+ EMBEDDING_MODEL, EMBEDDING_API_KEY).
 *  - **A local hash embedder**, used when nothing is configured. Feature hashing over word and
 *    character n-grams, TF-weighted and L2-normalised. It is not a language model and cannot
 *    know that «کمپین» and «campaign» are the same idea — but it is deterministic, needs no
 *    network, and beats nothing at all. The UI labels results produced this way.
 *
 * Persian normalisation happens first either way: Arabic ي/ك folded to Persian ی/ک, diacritics
 * and ZWNJ removed, digits unified. Without it «مي‌شود» and «می‌شود» are different words.
 */
import { env } from '../env.js';

export const LOCAL_MODEL = 'local-hash-v1';
export const LOCAL_DIMS = 256;

const ARABIC_TO_PERSIAN: Record<string, string> = { 'ي': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ؤ': 'و', 'ئ': 'ی' };
const DIGITS: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/** One spelling for one word, so the index and the query can meet. */
export function normalisePersian(input: string): string {
  return input
    .replace(/[ً-ٰٟـ]/g, '')        // harakat and tatweel
    .replace(/[‌‏‎]/g, ' ')              // ZWNJ and direction marks
    .replace(/[يكةۀأإآؤئ]/g, (c) => ARABIC_TO_PERSIAN[c] ?? c)
    .replace(/[۰-۹٠-٩]/g, (c) => DIGITS[c] ?? c)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Persian stop words carry no signal and crowd the hash space. */
const STOP = new Set([
  'و', 'در', 'به', 'از', 'که', 'این', 'را', 'با', 'است', 'برای', 'آن', 'یک', 'می', 'شد', 'شده',
  'های', 'ها', 'تا', 'بر', 'هم', 'یا', 'بود', 'باید', 'کرد', 'کند', 'شود', 'نیز', 'اگر', 'the', 'of', 'and', 'to', 'a', 'in',
]);

export function tokenise(text: string): string[] {
  return normalisePersian(text).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
}

/** FNV-1a — small, fast, and stable across runs, which a persisted index needs. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Feature hashing with a signed second hash, so unrelated words that collide tend to cancel
 * rather than pile up. Bigrams are included: «برند صنایع غذایی» should not reduce to three
 * unrelated words.
 */
export function localEmbed(text: string, dims = LOCAL_DIMS): number[] {
  const tokens = tokenise(text);
  const vector = new Array<number>(dims).fill(0);
  const add = (term: string, weight: number) => {
    const h = hash(term);
    const slot = h % dims;
    const sign = (hash(`#${term}`) & 1) === 0 ? 1 : -1;
    vector[slot]! += sign * weight;
  };
  for (const t of tokens) add(t, 1);
  for (let i = 0; i + 1 < tokens.length; i++) add(`${tokens[i]}_${tokens[i + 1]}`, 0.6);
  return normalise(vector);
}

/** L2 normalisation, so a dot product *is* the cosine and long documents do not win by length. */
export function normalise(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return length > 0 ? vector.map((v) => v / length) : vector;
}

export const cosine = (a: number[], b: number[]): number => {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i]! * b[i]!;
  return sum;
};

export interface Embedding { vector: number[]; model: string; dims: number }

export const embeddingServiceConfigured = (): boolean => env.EMBEDDING_URL.length > 0;

/**
 * The configured service where there is one, the local embedder otherwise. A service that
 * fails falls back rather than failing the request — a search that answers with weaker numbers
 * beats a search that answers with an error.
 */
export async function embed(text: string): Promise<Embedding> {
  const clean = normalisePersian(text).slice(0, 8_000);
  if (embeddingServiceConfigured()) {
    try {
      const res = await fetch(env.EMBEDDING_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.EMBEDDING_API_KEY ? { authorization: `Bearer ${env.EMBEDDING_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: clean }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: { embedding?: number[] }[] };
        const vector = body.data?.[0]?.embedding;
        if (Array.isArray(vector) && vector.length > 0) {
          return { vector: normalise(vector), model: env.EMBEDDING_MODEL, dims: vector.length };
        }
      }
    } catch { /* fall through to the local embedder */ }
  }
  return { vector: localEmbed(clean), model: LOCAL_MODEL, dims: LOCAL_DIMS };
}
