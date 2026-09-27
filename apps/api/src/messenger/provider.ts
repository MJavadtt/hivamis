/**
 * Where messenger messages go (roadmap #40). An adapter: a real bot needs a token issued by the
 * messenger to the organisation.
 *
 *   MESSENGER_MODE=off       nothing is sent; notifications stay in the app and in email
 *   MESSENGER_MODE=sandbox   an in-app chat per person — the whole flow, linking, buttons,
 *                            replies, with no messenger behind it
 *   MESSENGER_MODE=bale      Bale's bot API (Telegram-compatible, https://tapi.bale.ai)
 *   MESSENGER_MODE=telegram  Telegram's bot API
 *
 * Both live providers speak the Telegram Bot API shape: sendMessage with an inline keyboard,
 * editMessageText, answerCallbackQuery, setWebhook; updates arrive as `message` and
 * `callback_query`. The live transport has been written to that API and exercised against a stand-in,
 * not against Bale or Telegram themselves.
 */
import { env } from '../env.js';

export type Button = { text: string; action?: string; url?: string };
export interface MessengerProvider {
  name: 'sandbox' | 'bale' | 'telegram';
  send(chatId: string, text: string, buttons?: Button[][]): Promise<{ messageId: string }>;
  edit(chatId: string, messageId: string, text: string): Promise<void>;
  answerCallback(callbackId: string, text: string): Promise<void>;
  setWebhook?(url: string, secret: string): Promise<void>;
}

export const messengerMode = (): 'off' | 'sandbox' | 'bale' | 'telegram' =>
  env.MESSENGER_MODE ?? (env.NODE_ENV === 'production' ? 'off' : 'sandbox');

const DEFAULT_API: Record<'bale' | 'telegram', string> = { bale: 'https://tapi.bale.ai', telegram: 'https://api.telegram.org' };

/** Telegram's inline keyboard: callback buttons carry `a:<token>`, link buttons a URL. */
export const keyboard = (buttons?: Button[][]) => buttons?.length
  ? { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: `a:${b.action}` }))) }
  : undefined;

export function botApiProvider(opts: { name: 'bale' | 'telegram'; token: string; baseUrl?: string; fetchImpl?: typeof fetch }): MessengerProvider {
  const f = opts.fetchImpl ?? fetch;
  const base = `${(opts.baseUrl || DEFAULT_API[opts.name]).replace(/\/+$/, '')}/bot${opts.token}`;
  const call = async (method: string, body: object) => {
    const res = await f(`${base}/${method}`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => null) as { ok?: boolean; result?: any; description?: string } | null;
    // The token is in the URL of every call: an error must never repeat the URL.
    if (!res.ok || !json?.ok) throw new Error(`${method}: ${json?.description ?? `HTTP ${res.status}`}`);
    return json.result;
  };
  return {
    name: opts.name,
    async send(chatId, text, buttons) {
      const r = await call('sendMessage', { chat_id: chatId, text, reply_markup: keyboard(buttons) });
      return { messageId: String(r?.message_id ?? '') };
    },
    async edit(chatId, messageId, text) { await call('editMessageText', { chat_id: chatId, message_id: Number(messageId), text }); },
    async answerCallback(callbackId, text) { await call('answerCallbackQuery', { callback_query_id: callbackId, text }); },
    async setWebhook(url, secret) { await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'] }); },
  };
}

/** The sandbox keeps its chat in our own message log; sending is recording. */
export const sandboxProvider: MessengerProvider = {
  name: 'sandbox',
  async send() { return { messageId: '' }; },
  async edit() { /* the log row itself is updated by the caller */ },
  async answerCallback() { /* the sandbox page shows the answer from the response */ },
};

export function configuredProvider(): MessengerProvider | null {
  const mode = messengerMode();
  if (mode === 'off') return null;
  if (mode === 'sandbox') return sandboxProvider;
  if (!env.MESSENGER_BOT_TOKEN) return null;
  return botApiProvider({ name: mode, token: env.MESSENGER_BOT_TOKEN, baseUrl: env.MESSENGER_API_URL || undefined });
}
