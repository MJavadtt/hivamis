/**
 * Extension points on the workflow engine (roadmap #47).
 *
 * The engine used to read two maps compiled into the product, GUARDS and EFFECTS. They are now
 * registries filled at run time: the core registers its Doc_H guards and effects through the
 * same calls an extension makes, and the engine asks the registry what applies to a transition.
 * Rules come from three places:
 *
 *   core       Doc_H, in this repository
 *   extension  code an operator installs in EXTENSIONS_DIR, loaded at boot (src/extensions)
 *   custom     rules an organisation writes in the app, with no code (custom_rules)
 *
 * One property holds for all three: a rule can be added, never taken away. A key cannot be
 * registered twice, so nothing replaces a core guard; attached guards stand on top of the ones
 * Doc_H declares; extension effects run after the core effect and may not write `state` — only
 * the engine does.
 */
import { WORKFLOWS } from '@hiva/contracts';
import type { GuardContext, GuardResult } from './guards.js';
import type { EffectContext } from './effects.js';

export type RuleSource = 'core' | 'extension' | 'custom';

export interface GuardDefinition {
  key: string;
  labelFa: string;
  descriptionFa?: string;
  source: RuleSource;
  extension?: string;
  run: (c: GuardContext) => Promise<GuardResult>;
}

export interface EffectDefinition {
  key: string;
  entity: string;
  action: string;
  labelFa: string;
  source: RuleSource;
  extension?: string;
  /** What it returns is merged into the record's update, as a core effect's is. */
  run: (c: EffectContext) => Promise<Record<string, unknown> | void>;
}

export interface Attachment { entity: string; action: string; guard: string; source: RuleSource; extension?: string }

export class RegistryError extends Error {}

/** Fields an effect may never write: the engine owns the state, and identity is not an effect's. */
export const PROTECTED_FIELDS = new Set(['state', 'id', 'organizationId', 'code', 'createdAt']);

const guards = new Map<string, GuardDefinition>();
const attachments = new Map<string, Attachment[]>();
const effects = new Map<string, EffectDefinition[]>();

const KEY = /^[a-zA-Z][\w-]*(\.[\w-]+)+$/;
const transitionKey = (entity: string, action: string) => `${entity}.${action}`;
const declared = (entity: string, action: string) => WORKFLOWS[entity]?.transitions.filter((t) => t.action === action) ?? [];

export function registerGuard(def: GuardDefinition): void {
  if (!KEY.test(def.key)) throw new RegistryError(`guard key «${def.key}» must look like "namespace.name"`);
  if (guards.has(def.key)) throw new RegistryError(`guard «${def.key}» is already registered — a rule is added, never replaced`);
  guards.set(def.key, def);
}

/** Stand a registered guard on a transition, on top of those Doc_H declares for it. */
export function attachGuard(att: Attachment): void {
  const defs = declared(att.entity, att.action);
  if (!defs.length) throw new RegistryError(`no transition «${att.entity}.${att.action}» to attach «${att.guard}» to`);
  if (!guards.has(att.guard)) throw new RegistryError(`guard «${att.guard}» is not registered`);
  if (defs.every((d) => d.guards?.includes(att.guard))) return;           // Doc_H already asks for it
  const list = attachments.get(transitionKey(att.entity, att.action)) ?? [];
  if (!list.some((a) => a.guard === att.guard)) list.push(att);
  attachments.set(transitionKey(att.entity, att.action), list);
}

export function registerEffect(def: EffectDefinition): void {
  if (!KEY.test(def.key)) throw new RegistryError(`effect key «${def.key}» must look like "namespace.name"`);
  if (!declared(def.entity, def.action).length) throw new RegistryError(`no transition «${def.entity}.${def.action}» for effect «${def.key}»`);
  if ([...effects.values()].flat().some((e) => e.key === def.key)) throw new RegistryError(`effect «${def.key}» is already registered`);
  const list = effects.get(transitionKey(def.entity, def.action)) ?? [];
  // The core effect first, then the others in the order they were installed.
  list.splice(def.source === 'core' ? 0 : list.length, 0, def);
  effects.set(transitionKey(def.entity, def.action), list);
}

export const guardOf = (key: string) => guards.get(key);
export const hasGuard = (key: string) => guards.has(key);
export const guardLabel = (key: string) => guards.get(key)?.labelFa ?? key;

/** The registered guards a transition runs: Doc_H's, then those attached to it. */
export function guardsFor(entity: string, action: string, declaredGuards: readonly string[] | undefined): string[] {
  const extra = (attachments.get(transitionKey(entity, action)) ?? []).map((a) => a.guard);
  return [...(declaredGuards ?? []), ...extra.filter((g) => !declaredGuards?.includes(g))];
}

export const effectsFor = (entity: string, action: string): readonly EffectDefinition[] => effects.get(transitionKey(entity, action)) ?? [];

export const allGuards = () => [...guards.values()];
export const allEffects = () => [...effects.values()].flat();
export const allAttachments = () => [...attachments.values()].flat();

/** Everything an extension registered, removed — for reloading it, and for tests. The core stays. */
export function removeExtension(name: string): void {
  for (const [k, g] of guards) if (g.source === 'extension' && g.extension === name) guards.delete(k);
  for (const [k, list] of attachments) attachments.set(k, list.filter((a) => a.extension !== name));
  for (const [k, list] of effects) effects.set(k, list.filter((e) => e.extension !== name));
}

/**
 * What extensions add to the declared workflows, for the rule versions of #4: an installed,
 * removed or changed extension is a change of the rules, and gets a version like one. Empty when
 * nothing is installed, so the core's fingerprint is the same as before this existed.
 */
export function extensionSnapshot(): { attachments: string[]; effects: string[]; guards: string[] } | null {
  const ext = <T extends { source: RuleSource }>(xs: T[]) => xs.filter((x) => x.source === 'extension');
  const snapshot = {
    guards: ext(allGuards()).map((g) => `${g.extension}:${g.key}`).sort(),
    attachments: ext(allAttachments()).map((a) => `${a.entity}.${a.action}+${a.guard}`).sort(),
    effects: ext(allEffects()).map((e) => `${e.entity}.${e.action}+${e.key}`).sort(),
  };
  return snapshot.guards.length || snapshot.attachments.length || snapshot.effects.length ? snapshot : null;
}
