import type { AppHost } from "../../../../shared/apps.ts";

/** The smallest app for testing Mirador's app platform: a number that operations add to. */
interface Counter {
  count: number;
}

const added = (counter: Counter, by: number) => ({
  document: { count: counter.count + by },
  inverse: { op: "add", by: -by },
  summary: `Added ${by}; the count is ${counter.count + by}.`,
  touched: ["count"],
});

const host: AppHost<Counter> = {
  parse(text) {
    const value: unknown = JSON.parse(text);
    if (typeof (value as Partial<Counter> | null)?.count !== "number") throw new Error("not a counter: count must be a number");
    return value as Counter;
  },
  serialize: (counter) => `${JSON.stringify(counter, null, 2)}\n`,
  apply(counter, operation) {
    const { op, by } = operation as { op?: unknown; by?: unknown };
    if (op === "add" && typeof by === "number") return added(counter, by);
    if (op === "crash") return (undefined as unknown as { boom: () => never }).boom();
    throw new Error('Unknown operation; use { op: "add", by: <number> }.');
  },
  describe: (counter) => `The count is ${counter.count}.`,
  create: () => ({ count: 0 }),
};

export default host;
