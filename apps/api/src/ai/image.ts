import { env } from '../env.js';

/**
 * Pictures made inside the installation (audit F-2). An adapter, off unless the hardware allows:
 *
 *   IMAGE_MODE=off    nothing is drawn; the button is not shown
 *   IMAGE_MODE=local  a self-hosted LocalAI server (MIT) answering OpenAI's
 *                     POST /v1/images/generations, on the same internal network as the chat model —
 *                     the Compose profiles `image` (CPU) and `image-gpu`
 *
 * What is asked for never leaves the network. The adapter returns the bytes and nothing else: saving
 * them is the documents route's, with every check an upload has.
 */
export const imageServer = { url: env.IMAGE_URL.replace(/\/$/, ''), model: env.IMAGE_MODEL };

export const IMAGE_SIZES = ['512x512', '768x768', '1024x1024'] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

/** Whether pictures can be drawn here at all, and whether the server has the model. Two seconds at most. */
export async function imageStatus(): Promise<{ mode: 'off' | 'local'; ready: boolean; model: string | null }> {
  if (env.IMAGE_MODE === 'off') return { mode: 'off', ready: false, model: null };
  try {
    const res = await fetch(`${imageServer.url}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { mode: 'local', ready: false, model: imageServer.model };
    const body = await res.json() as { data?: { id: string }[] };
    return { mode: 'local', ready: (body.data ?? []).some((m) => m.id === imageServer.model), model: imageServer.model };
  } catch {
    return { mode: 'local', ready: false, model: imageServer.model };
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * One picture, as PNG bytes. On a CPU a 512px picture takes a minute or more; the caller waits, and
 * the request's own signal is the limit.
 */
export async function drawImage(prompt: string, size: ImageSize, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch(`${imageServer.url}/v1/images/generations`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: imageServer.model, prompt, size, n: 1, response_format: 'b64_json' }),
  });
  if (!res.ok) throw new Error(`image server ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const body = await res.json() as { data?: { b64_json?: string }[] };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error('image server answered without an image');
  const bytes = Buffer.from(b64, 'base64');
  // Whatever the server is, what is kept must be a PNG — checked here, and again by the upload route.
  if (!bytes.subarray(0, 8).equals(PNG)) throw new Error('image server answered with something other than a PNG');
  return bytes;
}
