import type { AppHost } from "../../../../shared/apps.ts";

/** A plugin as Mirador ships one: a view in TypeScript that imports another module, so it only runs once bundled. */
interface Tally {
  count: number;
}

const host: AppHost<Tally> = {
  parse: (text) => JSON.parse(text) as Tally,
  serialize: (tally) => `${JSON.stringify(tally)}\n`,
  apply(tally, operation) {
    const { op, by } = operation as { op?: unknown; by?: unknown };
    if (op !== "add" || typeof by !== "number") throw new Error('Unknown operation; use { op: "add", by: <number> }.');
    return { document: { count: tally.count + by }, inverse: { op: "add", by: -by }, summary: `The tally is ${tally.count + by}.` };
  },
  describe: (tally) => `The tally is ${tally.count}.`,
  create: () => ({ count: 0 }),
};

export default host;
