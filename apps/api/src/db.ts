import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  // The transition log's bookkeeping (audit LOG-1): a bigint JSON cannot carry, and nothing a reader
  // needs. Left out of every query; the webhook dispatcher asks for it by name.
  omit: { stateTransition: { txid: true }, webhookSubscription: { cursorTxid: true } },
});

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
