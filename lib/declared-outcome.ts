import type { Automation, Decision } from '@ajclarkson/homerun';
import { testAutomation } from '@ajclarkson/homerun/testing';

type TestOptions = Parameters<typeof testAutomation>[1];

// Resolves a decision against its automation's declaration the way the pipeline does, but
// throws instead of publishing a `declaration_error`: at run time a violation drops outcome and
// facts silently, so tests must prove no branch ever causes one.
export function declared(
  automation: Pick<Automation<unknown>, 'reasons'>,
  decision: Pick<Decision, 'reason' | 'facts'>,
): { outcome: string; facts: Record<string, unknown> | undefined } {
  const reasons = automation.reasons;
  if (!reasons) throw new Error('automation declares no reasons');
  const { reason, facts } = decision;
  if (typeof reason !== 'string' || !Object.hasOwn(reasons, reason)) {
    throw new Error(`undeclared reason ${JSON.stringify(reason)}`);
  }
  const spec = reasons[reason];
  const wanted = [...(spec.facts ?? [])].sort();
  const given = Object.keys(facts ?? {}).sort();
  if (JSON.stringify(wanted) !== JSON.stringify(given)) {
    throw new Error(`reason ${reason}: declared facts [${wanted}] but got [${given}]`);
  }
  for (const [key, value] of Object.entries(facts ?? {})) {
    const ok = value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value));
    if (!ok) throw new Error(`reason ${reason}: fact ${key} is not a string, finite number, boolean or null`);
  }
  return { outcome: spec.outcome, facts: facts as Record<string, unknown> | undefined };
}

// testAutomation plus the declaration check on every decision, so a branch that returns an
// undeclared reason or the wrong facts fails its test. The result carries the resolved `outcome`.
export function testDeclared<C>(automation: Automation<C>, options: TestOptions) {
  const decision = testAutomation(automation, options);
  const { outcome } = declared(automation, decision);
  return { ...decision, outcome };
}
