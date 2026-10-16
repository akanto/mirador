import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export type Spec = { file: string; title: string };
export type KnownIssue = Spec & { reason: string; bead?: string };
export type Verdict = { tolerated: KnownIssue[]; uncovered: Spec[]; statedButPassing: KnownIssue[] };

const collect = (node: unknown, inheritedFile: string, seen: Spec[], failing: Spec[], flaky: Spec[]) => {
  if (Array.isArray(node)) return node.forEach((child) => collect(child, inheritedFile, seen, failing, flaky));
  if (typeof node !== "object" || node === null) return;
  const suite = node as Record<string, unknown>;
  const file = typeof suite.file === "string" ? suite.file : inheritedFile;
  for (const spec of (suite.specs as Record<string, unknown>[] | undefined) ?? []) {
    const statuses = ((spec.tests as Record<string, unknown>[] | undefined) ?? []).map((test) => test.status as string);
    const titled = { file, title: spec.title as string };
    seen.push(titled);
    if (statuses.includes("unexpected")) failing.push(titled);
    else if (statuses.includes("flaky")) flaky.push(titled);
  }
  collect(suite.suites, file, seen, failing, flaky);
};

/** The specs a Playwright JSON report names, the ones it ends on as failed, and the ones that failed once and passed on a retry. */
export function specsThatFailed(report: unknown): { seen: Spec[]; failing: Spec[]; flaky: Spec[] } {
  const seen: Spec[] = [];
  const failing: Spec[] = [];
  const flaky: Spec[] = [];
  collect(report, "", seen, failing, flaky);
  return { seen, failing, flaky };
}

/** Sorting the suite's failures against the stated reasons: what the release may go out over, and what holds it. */
export function verdictAgainstKnownIssues(failing: Spec[], stated: KnownIssue[]): Verdict {
  const sameSpec = (a: Spec) => (b: Spec) => basename(a.file) === basename(b.file) && a.title === b.title;
  const isStated = (spec: Spec) => stated.some((issue) => sameSpec(issue)(spec));
  return {
    tolerated: stated.filter((issue) => failing.some(sameSpec(issue))),
    uncovered: failing.filter((spec) => !isStated(spec)),
    statedButPassing: stated.filter((issue) => !failing.some(sameSpec(issue))),
  };
}

const asLines = (specs: Spec[]) => specs.map((spec) => `  ${spec.file}: ${spec.title}`);

if (import.meta.main) {
  const [reportPath = "survey.json", statedPath = "e2e/windows-known-issues.json"] = process.argv.slice(2);
  if (!existsSync(reportPath)) {
    console.error(`${reportPath} is missing, so the suite never got as far as writing a report.`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const stated = JSON.parse(readFileSync(statedPath, "utf8")) as KnownIssue[];
  const { seen, failing, flaky } = specsThatFailed(report);
  const { tolerated, uncovered, statedButPassing } = verdictAgainstKnownIssues(failing, stated);

  if (!seen.length) {
    console.error(`${reportPath} names no specs, so the suite did not get to run.`);
    process.exit(1);
  }
  console.log(`${seen.length} specs ran, ${failing.length} ended failing, ${flaky.length} failed once and passed on a retry.`);
  if (flaky.length) console.log(asLines(flaky).join("\n"));

  console.log(`\nGoing over a stated reason (${tolerated.length}):`);
  for (const issue of tolerated) {
    console.log(`  ${issue.file}: ${issue.title}`);
    console.log(`      ${issue.bead ? `${issue.bead}: ` : ""}${issue.reason}`);
  }
  if (statedButPassing.length) {
    console.log(`\nStated but passing now, so ${statedPath} can drop them:`);
    console.log(asLines(statedButPassing).join("\n"));
  }

  console.log(`\nFailing with no stated reason (${uncovered.length}):`);
  console.log(uncovered.length ? asLines(uncovered).join("\n") : "  none");
  process.exit(uncovered.length ? 1 : 0);
}
