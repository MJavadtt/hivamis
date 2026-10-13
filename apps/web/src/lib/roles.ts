import { useQuery } from '@tanstack/react-query';
import { ROLE_CODES, ROLE_LABELS, type RoleCode } from '@hiva/contracts';
import { apiGet } from './api';
import { loc, pair } from '../i18n';

/**
 * The organisation's roles by name — the code's, and its own (audit F-3). The code's names are known
 * without asking; an organisation's own come from /roles, kept here once read, so a helper outside a
 * component (a table cell's formatter) names them too.
 */

interface RoleName { code: string; nameFa: string; nameEn: string }
const known = new Map<string, RoleName>();

/** A role's name: the organisation's own from /roles, the code's from its labels, else its code. */
export const roleName = (code: string): string => {
  const r = known.get(code);
  return r ? loc(r, 'name') : pair(ROLE_LABELS[code as RoleCode]) || code;
};

/** Every role the organisation has, read once and kept for five minutes; calling it also teaches roleName. */
export function useRoles(): RoleName[] {
  const { data } = useQuery<RoleName[]>({
    queryKey: ['/roles'], queryFn: () => apiGet('/roles'), staleTime: 300_000,
  });
  // Until it arrives (or if it cannot be read), the code's roles alone.
  if (!Array.isArray(data)) return ROLE_CODES.map((code) => ({ code, nameFa: '', nameEn: '' }));
  for (const r of data) known.set(r.code, r);
  return data;
}

/** The codes to choose from: the code's, then the organisation's own. */
export function useRoleCodes(): string[] {
  return useRoles().map((r) => r.code);
}
