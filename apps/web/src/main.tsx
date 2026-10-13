import { applyStoredThemeEarly } from './lib/theme';
import { applyStoredLocaleEarly } from './lib/locale';
import { watchPower } from './lib/power';
import { loadCatalogues } from './i18n';

// Before the first paint, so a dark-mode user never sees a flash of the light interface.
applyStoredThemeEarly();
applyStoredLocaleEarly();
// Also before it: a device with few cores never draws the blur at all (audit UI-3).
watchPower();

/**
 * English needs its catalogues before any module of the app runs — tab lists and column headers are
 * translated when their module loads (Hivamis task 7). Persian needs nothing and waits for nothing;
 * a catalogue that fails to load leaves the interface in Persian rather than blank.
 */
void loadCatalogues()
  .catch(() => undefined)
  .then(() => import('./boot'));
