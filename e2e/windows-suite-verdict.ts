import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export type Spec = { file: string; title: string };
export type KnownIssue = Spec & { reason: string; bead?: string };
export type Verdict = { tolerated: KnownIssue[]; uncovered: Spec[]; statedButPassing: KnownIssue[] };

type ReportTest = { status?: string; expectedStatus?: string; results?: { status?: string }[] };
type Outcomes = { seen: Spec[]; failing: Spec[]; flaky: Spec[]; interrupted: Spec[]; didNotRun: Spec[] };

/** As Playwright's own summary tells them apart: a skipped test that was cut short, or that was meant to run and never did, is no skip. */
function outcomeOf(test: ReportTest): keyof Omit<Outcomes, "seen"> | null {
  if (test.status === "unexpected") return "failing";
  if (test.status === "flaky") return "flaky";
  if (test.status !== "skipped") return null;
  const results = test.results ?? [];
  if (results.some((result) => result.status === "interrupted")) return "interrupted";
  return results.length === 0 || test.expectedStatus !== "skipped" ? "didNotRun" : null;
}

const outcomeOrder = ["failing", "interrupted", "didNotRun", "flaky"] as const;

const collect = (node: unknown, inheritedFile: string, outcomes: Outcomes) => {
  if (Array.isArray(node)) return node.forEach((child) => collect(child, inheritedFile, outcomes));
  if (typeof node !== "object" || node === null) return;
  const suite = node as Record<string, unknown>;
  const file = typeof suite.file === "string" ? suite.file : inheritedFile;
  for (const spec of (suite.specs as Record<string, unknown>[] | undefined) ?? []) {
    const found = new Set(((spec.tests as ReportTest[] | undefined) ?? []).map(outcomeOf));
    const titled = { file, title: spec.title as string };
    outcomes.seen.push(titled);
    const worst = outcomeOrder.find((outcome) => found.has(outcome));
    if (worst) outcomes[worst].push(titled);
  }
  collect(suite.suites, file, outcomes);
};

/**
 * The specs a Playwright JSON report names, the ones it ends on as failed, the ones that failed once and passed on a
 * retry, and the ones that were cut short or never ran.
 */
export function specsThatFailed(report: unknown): Outcomes {
  const outcomes: Outcomes = { seen: [], failing: [], flaky: [], interrupted: [], didNotRun: [] };
  collect(report, "", outcomes);
  return outcomes;
}

/** A spec left out after a failure in its file, as a serial file stops at its first failure, is that failure's to explain; any other was cut off. */
export function specsLeftOut(didNotRun: Spec[], failing: Spec[]) {
  const followsAFailure = (spec: Spec) => failing.some((failure) => basename(failure.file) === basename(spec.file));
  return { afterAFailure: didNotRun.filter(followsAFailure), unexplained: didNotRun.filter((spec) => !followsAFailure(spec)) };
}

/** The errors outside any test, such as the suite running out of its global time. */
export const reportErrors = (report: unknown) =>
  (((report as { errors?: { message?: string }[] }).errors ?? []).map((error) => String(error.message ?? "").split("\n")[0]!));

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
  const { seen, failing, flaky, interrupted, didNotRun } = specsThatFailed(report);
  const { tolerated, uncovered, statedButPassing } = verdictAgainstKnownIssues(failing, stated);
  const { afterAFailure, unexplained } = specsLeftOut(didNotRun, failing);
  const errors = reportErrors(report);

  if (!seen.length) {
    console.error(`${reportPath} names no specs, so the suite did not get to run.`);
    process.exit(1);
  }
  console.log(`${seen.length} specs ran, ${failing.length} ended failing, ${flaky.length} failed once and passed on a retry.`);
  if (flaky.length) console.log(asLines(flaky).join("\n"));
  if (afterAFailure.length) {
    console.log(`\nNot run, as an earlier failure in their file stopped it (${afterAFailure.length}):`);
    console.log(asLines(afterAFailure).join("\n"));
  }

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
  const cutShort = [
    { heading: "Errors outside any test", lines: errors.map((error) => `  ${error}`) },
    { heading: "Cut short as they ran", lines: asLines(interrupted) },
    { heading: "Never ran, with nothing in their file failing", lines: asLines(unexplained) },
  ].filter(({ lines }) => lines.length);
  for (const { heading, lines } of cutShort) console.log(`\n${heading} (${lines.length}):\n${lines.join("\n")}`);
  process.exit(uncovered.length || cutShort.length ? 1 : 0);
}
