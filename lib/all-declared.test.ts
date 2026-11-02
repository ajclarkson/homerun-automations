import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Automation } from '@ajclarkson/homerun';

// Undeclared automations store every decision that has an action in the per-location history, which
// drowns the meaningful entries. This loads every automation file the way the runtime does and fails
// on one that declares no reasons, so a new automation cannot ship undeclared.
const ROOT = resolve(import.meta.dirname, '..');
const NOT_AUTOMATIONS = new Set(['lib', 'types', 'scripts', 'agent_docs', 'node_modules']);
const REASON_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const OUTCOMES = new Set(['acted', 'declined', 'ignored']);

function automationFiles(): string[] {
  return readdirSync(ROOT)
    .filter((dir) => !dir.startsWith('.') && !NOT_AUTOMATIONS.has(dir) && statSync(join(ROOT, dir)).isDirectory())
    .flatMap((dir) => readdirSync(join(ROOT, dir))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join(dir, file)));
}

async function loadAll(): Promise<{ file: string; automation: Automation<unknown> }[]> {
  const loaded = await Promise.all(automationFiles().map(async (file) => {
    const mod = await import(join(ROOT, file));
    const exported: unknown = mod.default;
    return (Array.isArray(exported) ? exported : [exported]).map((automation) => ({ file, automation: automation as Automation<unknown> }));
  }));
  return loaded.flat();
}

describe('every automation declares its reasons', () => {
  it('finds the automations (guards against the glob silently matching nothing)', async () => {
    expect((await loadAll()).length).toBeGreaterThan(60);
  });

  it('gives every automation a non-empty table of valid reasons with a known outcome', async () => {
    const problems: string[] = [];
    for (const { file, automation } of await loadAll()) {
      const reasons = automation.reasons;
      if (!reasons || Object.keys(reasons).length === 0) {
        problems.push(`${file} (${automation.id}): no reasons declared`);
        continue;
      }
      for (const [name, spec] of Object.entries(reasons)) {
        if (!REASON_NAME.test(name)) problems.push(`${automation.id}: reason ${JSON.stringify(name)} is not a static identifier`);
        if (!OUTCOMES.has(spec.outcome)) problems.push(`${automation.id}: reason ${name} has outcome ${spec.outcome}`);
        if ((spec.facts ?? []).length > 8) problems.push(`${automation.id}: reason ${name} declares more than 8 facts`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('has unique automation ids', async () => {
    const ids = (await loadAll()).map(({ automation }) => automation.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});
