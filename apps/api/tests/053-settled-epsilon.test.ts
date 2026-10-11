import { describe, it, expect } from 'vitest';
import { CURRENCIES, minorUnitsOf } from '@hiva/contracts';
import { settledEpsilon } from '../src/finance/fx.js';

/**
 * Audit CALC-3: "fully settled" allowed a fixed 0.005 whatever the currency. It is now half of the
 * currency's smallest unit as ISO 4217 has it — the last digit of a rate conversion is not a debt,
 * and nothing smaller than a currency's own smallest coin is asked of anyone.
 */
describe('Settled to the currency’s own smallest unit (audit CALC-3)', () => {
  it('is half a cent in every currency the system offers, all of which have two digits', () => {
    for (const c of CURRENCIES) expect([c, minorUnitsOf(c), settledEpsilon(c).toString()]).toEqual([c, 2, '0.005']);
  });

  it('is half a yen without cents, and half a fils with three digits', () => {
    expect(settledEpsilon('JPY').toString()).toBe('0.5');
    expect(settledEpsilon('KWD').toString()).toBe('0.0005');
    expect(settledEpsilon('iqd').toString()).toBe('0.0005');
    // A currency not listed is taken to have cents, the common case.
    expect(settledEpsilon('XYZ').toString()).toBe('0.005');
  });
});
