/**
 * Extensions (roadmap #47): an organisation's own code rules, added without forking the product.
 *
 * An extension is a module in EXTENSIONS_DIR whose default export is
 *
 *   { name: 'acme', version: '1.2.0', register(api) { … } }
 *
 * and `register` receives the same calls the core uses: registerGuard, attachGuard,
 * registerEffect. Everything it registers is named under its own namespace ("acme.…"), so it can
 * neither collide with Doc_H's rules nor with another extension's; and what it registers can only
 * add a rule — the registry refuses a key twice and the engine refuses an effect that writes the
 * state or rewrites what the core set.
 *
 * Loading fails closed: an extension that throws, or names a transition or guard that does not
 * exist, stops the boot. Running with some of an organisation's rules silently missing would be
 * worse than not running — the workflow would look governed and not be.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKFLOWS, availableTransitions } from '@hiva/contracts';
import { env } from '../env.js';
import {
  RegistryError, attachGuard, registerEffect, registerGuard, removeExtension,
  type EffectDefinition, type GuardDefinition,
} from '../workflow/registry.js';
import type { GuardContext, GuardResult } from '../workflow/guards.js';
import type { EffectContext } from '../workflow/effects.js';

export interface ExtensionApi {
  /** Declare a guard. `key` must start with "<extension name>.". */
  registerGuard(def: { key: string; labelFa: string; descriptionFa?: string; run: (c: GuardContext) => Promise<GuardResult> }): void;
  /** Stand a guard on a transition, on top of those Doc_H declares. */
  attachGuard(entity: string, action: string, guard: string): void;
  /** Run after the core effect of a transition; what it returns is added to the record's update. */
  registerEffect(def: { key: string; entity: string; action: string; labelFa: string; run: (c: EffectContext) => Promise<Record<string, unknown> | void> }): void;
  /** The state machines, read-only, to find transitions by name. */
  readonly workflows: typeof WORKFLOWS;
  readonly availableTransitions: typeof availableTransitions;
}

export interface Extension {
  name: string;
  version: string;
  descriptionFa?: string;
  register(api: ExtensionApi): void | Promise<void>;
}

export interface LoadedExtension {
  name: string; version: string; descriptionFa: string | null; file: string;
  guards: string[]; attachments: string[]; effects: string[];
}

const NAME = /^[a-z][a-z0-9-]{1,39}$/;
const loaded = new Map<string, LoadedExtension>();
let booted = false;

export const loadedExtensions = (): LoadedExtension[] => [...loaded.values()];

/** Install one extension object — what loading a module does, and what a test does directly. */
export async function installExtension(ext: Extension, file = '(in process)'): Promise<LoadedExtension> {
  if (!ext || typeof ext.register !== 'function' || typeof ext.name !== 'string' || typeof ext.version !== 'string') {
    throw new RegistryError(`${file}: an extension exports { name, version, register(api) }`);
  }
  if (!NAME.test(ext.name)) throw new RegistryError(`${file}: extension name «${ext.name}» must be lower-case latin, 2–40 characters`);
  if (loaded.has(ext.name)) throw new RegistryError(`${file}: extension «${ext.name}» is already installed`);
  const record: LoadedExtension = { name: ext.name, version: ext.version, descriptionFa: ext.descriptionFa ?? null, file, guards: [], attachments: [], effects: [] };
  const own = (key: string) => {
    if (!key.startsWith(`${ext.name}.`)) throw new RegistryError(`${ext.name}: «${key}» must be named under "${ext.name}."`);
  };
  const api: ExtensionApi = {
    registerGuard: (def) => {
      own(def.key);
      registerGuard({ ...def, source: 'extension', extension: ext.name } satisfies GuardDefinition);
      record.guards.push(def.key);
    },
    attachGuard: (entity, action, guard) => {
      attachGuard({ entity, action, guard, source: 'extension', extension: ext.name });
      record.attachments.push(`${entity}.${action}+${guard}`);
    },
    registerEffect: (def) => {
      own(def.key);
      registerEffect({ ...def, source: 'extension', extension: ext.name } satisfies EffectDefinition);
      record.effects.push(`${def.entity}.${def.action}+${def.key}`);
    },
    workflows: WORKFLOWS,
    availableTransitions,
  };
  try {
    await ext.register(api);
  } catch (e) {
    removeExtension(ext.name);                     // half an extension is not installed
    throw e instanceof RegistryError ? e : new RegistryError(`${ext.name}: ${(e as Error).message}`);
  }
  loaded.set(ext.name, record);
  return record;
}

/** Uninstall — for tests, and for an operator reloading one without a restart of everything else. */
export function uninstallExtension(name: string): void {
  removeExtension(name);
  loaded.delete(name);
}

/** Every `.js` / `.mjs` module in the directory, in name order. */
export async function loadExtensions(dir = env.EXTENSIONS_DIR): Promise<LoadedExtension[]> {
  // Once per process: building the app again (tests do) does not install them twice.
  if (booted || !dir) return loadedExtensions();
  booted = true;
  const root = path.resolve(dir);
  const files = (await readdir(root)).filter((f) => /\.(m?js)$/.test(f)).sort();
  const out: LoadedExtension[] = [];
  for (const f of files) {
    const file = path.join(root, f);
    const mod = await import(pathToFileURL(file).href) as { default?: Extension };
    out.push(await installExtension(mod.default as Extension, f));
  }
  return out;
}
