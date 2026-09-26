/**
 * The unique tax number of an e-invoice (roadmap #32), «شمارهٔ منحصربه‌فرد مالیاتی».
 *
 * 22 characters: the fiscal memory id (6), the issue day as days since 1970 in hex (5), the
 * invoice's serial in hex (10), and a Verhoeff check digit (1). The check digit is computed over a
 * decimal string: the memory id with each letter replaced by its ASCII code, the day padded to 6
 * digits, the serial padded to 12. This follows the public SDKs of the tax authority's API
 * (e.g. Jooyeshgar/moadian, InvoiceHeader::setTaxID); a live submission is its real test.
 */
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function verhoeffDigit(digits: string): number {
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) c = D[c]![P[(i + 1) % 8]![Number(rev[i])]!]!;
  return INV[c]!;
}
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) c = D[c]![P[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

/** Letters become their ASCII codes; digits stay. */
export const memoryIdToNumber = (memoryId: string) =>
  memoryId.toUpperCase().split('').map((ch) => (/\d/.test(ch) ? ch : String(ch.charCodeAt(0)))).join('');

export const daysSinceEpoch = (issuedAt: Date) => Math.floor(issuedAt.getTime() / 86_400_000);

export function taxIdFor(memoryId: string, issuedAt: Date, serial: number): string {
  if (!/^[A-Za-z0-9]{6}$/.test(memoryId)) throw new Error('memory id must be six letters or digits');
  if (!Number.isInteger(serial) || serial < 1 || serial > 0xff_ffff_ffff) throw new Error('serial out of range');
  const days = daysSinceEpoch(issuedAt);
  const control = memoryIdToNumber(memoryId) + String(days).padStart(6, '0') + String(serial).padStart(12, '0');
  return `${memoryId}${days.toString(16).padStart(5, '0')}${serial.toString(16).padStart(10, '0')}${verhoeffDigit(control)}`.toUpperCase();
}

/** The check digit a tax number carries is the one its parts produce. */
export function taxIdChecks(taxId: string): boolean {
  const m = taxId.match(/^([A-Z0-9]{6})([0-9A-F]{5})([0-9A-F]{10})(\d)$/);
  if (!m) return false;
  const control = memoryIdToNumber(m[1]!) + String(parseInt(m[2]!, 16)).padStart(6, '0') + String(parseInt(m[3]!, 16)).padStart(12, '0');
  return verhoeffValid(control + m[4]);
}
