/**
 * What the logs never carry (audit SEC-11). Fastify does not log bodies by default, so most of these
 * never reach a log today; listed anyway, so the day someone turns body logging on — or logs a
 * request to debug it — a password, a code or a token is not what they find there.
 *
 * Paths are pino's: relative to the logged object, so both a request's headers and a body logged on
 * its own are covered.
 */
export const LOG_REDACT = [
  'req.headers.authorization',
  'req.headers.cookie', // the refresh cookie and the Google binding nonce
  'req.headers["x-hiva-signature"]',
  'res.headers["set-cookie"]',
  ...['password', 'newPassword', 'currentPassword', 'refreshToken', 'code', 'ticket', 'token'].flatMap((k) => [`body.${k}`, `req.body.${k}`]),
];
