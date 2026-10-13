import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ACTION_LABELS } from '../src/lib/audit-labels';

/** Audit UI-V: the audit trail showed an action as the code spells it. Every action the API writes has a name. */

const api = path.resolve(__dirname, '../../api/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f);
  return statSync(p).isDirectory() ? files(p) : f.endsWith('.ts') ? [p] : [];
});

describe('Audit action names', () => {
  it('names every action the API writes', () => {
    const written = new Set<string>();
    for (const f of files(api)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        // The expression after `action:` — a literal, or a choice between literals.
        for (const expr of line.matchAll(/\baction:\s*([^,}]+)/g)) {
          for (const m of expr[1]!.matchAll(/'([A-Z][A-Z_]{3,})'/g)) written.add(m[1]!);
        }
      }
    }
    expect(written.size).toBeGreaterThan(30);
    expect([...written].filter((a) => !ACTION_LABELS[a]).sort()).toEqual([]);
  });
});
