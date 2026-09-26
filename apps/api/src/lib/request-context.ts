/**
 * What the current request is, for code far from the request object (roadmap #46): `audit()` is
 * called from dozens of places with an explicit actor, and the one thing none of them passes is
 * which API key, if any, the request came through. Opened per request in an onRequest hook, so
 * the store is the request's own; authentication writes into it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext { apiKeyId?: string }

export const requestContext = new AsyncLocalStorage<RequestContext>();
