/**
 * What the current request is, for code far from the request object (roadmap #46): `audit()` is
 * called from dozens of places with an explicit actor, and the one thing none of them passes is
 * which API key, if any, the request came through. Opened per request in an onRequest hook, so
 * the store is the request's own; authentication writes into it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  apiKeyId?: string;
  /** The person the assistant is reading for (audit PERF-1). See {@link asAgentFor}. */
  agentFor?: string;
  /** The system administrator working in the authenticated person's account, if one is (owner's report, 2026-10-23). */
  actingAdminId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Audit PERF-1: the assistant reads through the API in-process (app.inject), so every person's reads
 * arrived from 127.0.0.1 and shared one rate-limit bucket. Requests made inside this scope carry the
 * person into their own context, and the limiter counts them as that person's. Nothing from outside
 * can claim it: a request off the network begins in the server's own context, where this scope never
 * is — there is no header to forge.
 */
export const asAgentFor = <T>(userId: string, work: () => Promise<T>): Promise<T> => requestContext.run({ agentFor: userId }, work);

/** The rate-limit bucket: the person, for the assistant's reads on their behalf; otherwise the address. */
export const rateKey = (ip: string): string => {
  const agent = requestContext.getStore()?.agentFor;
  return agent ? `agent:${agent}` : ip;
};
