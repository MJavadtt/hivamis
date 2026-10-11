import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { FastifyReply } from 'fastify';

/**
 * Opens a server-sent event stream on a hijacked reply (audit PERF-6). Hijacking hands the raw response
 * over, and with it everything Fastify would have added on the way out: the CORS headers @fastify/cors
 * and the security headers @fastify/helmet had already set on the reply. They are copied in here, under
 * the stream's own headers.
 */
export function openEventStream(reply: FastifyReply): ServerResponse {
  const headers: OutgoingHttpHeaders = {
    ...(reply.getHeaders() as OutgoingHttpHeaders),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx would otherwise hold the stream in its buffer (infrastructure/docker/nginx.conf).
    'x-accel-buffering': 'no',
  };
  reply.hijack();
  reply.raw.writeHead(200, headers);
  return reply.raw;
}
