// Minimal sequential test runner tailored for LIVE-store E2E: one shared browser, scenarios run in
// order, each gets a clean cart, failures are collected (the run continues) and summarized with a
// non-zero exit on any failure. A tiny assertion API throws AssertionError with a readable message.

export class AssertionError extends Error {}

export const assert = {
  ok(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new AssertionError(msg);
  },
  eq<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) {
      throw new AssertionError(
        `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  },
  includes(haystack: string, needle: string, msg: string): void {
    if (!haystack.includes(needle)) {
      throw new AssertionError(`${msg} — expected "${haystack}" to include "${needle}"`);
    }
  },
  gte(actual: number, min: number, msg: string): void {
    if (!(actual >= min)) throw new AssertionError(`${msg} — expected ${actual} >= ${min}`);
  },
  lt(actual: number, max: number, msg: string): void {
    if (!(actual < max)) throw new AssertionError(`${msg} — expected ${actual} < ${max}`);
  },
  between(actual: number, lo: number, hi: number, msg: string): void {
    if (!(actual >= lo && actual <= hi)) {
      throw new AssertionError(`${msg} — expected ${lo} <= ${actual} <= ${hi}`);
    }
  },
};

export type Scenario<Ctx> = {
  id: string;
  name: string;
  run: (ctx: Ctx) => Promise<void>;
};

export type RunOutcome = { id: string; name: string; ok: boolean; ms: number; error?: string };

export async function runAll<Ctx>(
  scenarios: Scenario<Ctx>[],
  ctx: Ctx,
  hooks: { before?: (s: Scenario<Ctx>) => Promise<void> } = {},
): Promise<RunOutcome[]> {
  const results: RunOutcome[] = [];
  for (const s of scenarios) {
    const start = Date.now();
    process.stdout.write(`\n▶ ${s.id}  ${s.name}\n`);
    try {
      if (hooks.before) await hooks.before(s);
      await s.run(ctx);
      const ms = Date.now() - start;
      results.push({ id: s.id, name: s.name, ok: true, ms });
      process.stdout.write(`  ✅ PASS (${ms} ms)\n`);
    } catch (err) {
      const ms = Date.now() - start;
      const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
      results.push({ id: s.id, name: s.name, ok: false, ms, error });
      process.stdout.write(
        `  ❌ FAIL (${ms} ms): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return results;
}

export function printSummary(results: RunOutcome[]): number {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  process.stdout.write(`\n${'='.repeat(60)}\n`);
  process.stdout.write(`E2E SUMMARY: ${passed}/${results.length} passed, ${failed} failed\n`);
  process.stdout.write(`${'='.repeat(60)}\n`);
  for (const r of results) {
    process.stdout.write(`${r.ok ? '✅' : '❌'} ${r.id}  ${r.name} (${r.ms} ms)\n`);
    if (!r.ok && r.error) {
      const firstLine = r.error.split('\n').slice(0, 4).join('\n    ');
      process.stdout.write(`    ${firstLine}\n`);
    }
  }
  return failed;
}
