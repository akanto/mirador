import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specsLeftOut, specsThatFailed, verdictAgainstKnownIssues } from "../e2e/windows-suite-verdict.ts";
import type { KnownIssue } from "../e2e/windows-suite-verdict.ts";

type ReportedSpec = { file: string; title: string; status: string; expectedStatus?: string; results?: { status: string }[] };

const report = (...specs: ReportedSpec[]) => ({
  suites: specs.map((spec) => ({
    file: spec.file,
    specs: [
      {
        title: spec.title,
        tests: [
          {
            status: spec.status,
            expectedStatus: spec.expectedStatus ?? (spec.status === "skipped" ? "skipped" : "passed"),
            results: spec.results ?? [{ status: spec.status === "skipped" ? "skipped" : "passed" }],
          },
        ],
      },
    ],
  })),
});

test("a spec that ends failing is a failure, one that passes on a retry is only flaky", () => {
  const { failing, flaky } = specsThatFailed(
    report(
      { file: "a.spec.ts", title: "works", status: "expected" },
      { file: "b.spec.ts", title: "breaks", status: "unexpected" },
      { file: "c.spec.ts", title: "breaks then works", status: "flaky" },
      { file: "d.spec.ts", title: "does not run here", status: "skipped" },
    ),
  );
  expect(failing).toEqual([{ file: "b.spec.ts", title: "breaks" }]);
  expect(flaky).toEqual([{ file: "c.spec.ts", title: "breaks then works" }]);
});

test("a test cut short as it ran, or one meant to run that never did, is no skip, as Playwright's own summary counts them", () => {
  const { interrupted, didNotRun } = specsThatFailed(
    report(
      { file: "a.spec.ts", title: "skipped on purpose", status: "skipped" },
      { file: "b.spec.ts", title: "running at the global timeout", status: "skipped", expectedStatus: "passed", results: [{ status: "interrupted" }] },
      { file: "c.spec.ts", title: "never started", status: "skipped", expectedStatus: "passed", results: [] },
      { file: "d.spec.ts", title: "after a failure in a serial file", status: "skipped", expectedStatus: "passed", results: [{ status: "skipped" }] },
    ),
  );
  expect(interrupted).toEqual([{ file: "b.spec.ts", title: "running at the global timeout" }]);
  expect(didNotRun).toEqual([
    { file: "c.spec.ts", title: "never started" },
    { file: "d.spec.ts", title: "after a failure in a serial file" },
  ]);
});

test("a spec left out after a failure in its file is that failure's, any other was cut off", () => {
  const leftOut = [
    { file: "e2e/serial.spec.ts", title: "second step" },
    { file: "other.spec.ts", title: "never reached" },
  ];
  expect(specsLeftOut(leftOut, [{ file: "serial.spec.ts", title: "first step" }])).toEqual({
    afterAFailure: [{ file: "e2e/serial.spec.ts", title: "second step" }],
    unexplained: [{ file: "other.spec.ts", title: "never reached" }],
  });
});

test("specs nested in a folder suit take the folder's file", () => {
  const { failing } = specsThatFailed({
    suites: [{ file: "desktop", suites: [{ specs: [{ title: "tray works", tests: [{ status: "unexpected" }] }] }] }],
  });
  expect(failing).toEqual([{ file: "desktop", title: "tray works" }]);
});

test("a stated reason lets its failure through, an unstated one holds the release", () => {
  const stated: KnownIssue[] = [{ file: "b.spec.ts", title: "breaks", reason: "windows has no such shell", bead: "vcs-one" }];
  const { failing } = specsThatFailed(
    report(
      { file: "e2e/b.spec.ts", title: "breaks", status: "unexpected" },
      { file: "b.spec.ts", title: "breaks", status: "unexpected" },
      { file: "z.spec.ts", title: "newly broken", status: "unexpected" },
    ),
  );
  const { tolerated, uncovered, statedButPassing } = verdictAgainstKnownIssues(failing, stated);
  expect(tolerated).toEqual(stated);
  expect(uncovered).toEqual([{ file: "z.spec.ts", title: "newly broken" }]);
  expect(statedButPassing).toEqual([]);
});

test("a reason whose spec passes again is offered for removal from the list", () => {
  const stated: KnownIssue[] = [
    { file: "a.spec.ts", title: "works", reason: "fixed but not yet trimmed" },
    { file: "b.spec.ts", title: "breaks", reason: "still broken" },
  ];
  const { failing } = specsThatFailed(
    report(
      { file: "a.spec.ts", title: "works", status: "expected" },
      { file: "b.spec.ts", title: "breaks", status: "unexpected" },
    ),
  );
  expect(verdictAgainstKnownIssues(failing, stated).statedButPassing).toEqual([stated[0]]);
});

const repoRoot = join(import.meta.dir, "..");
const statedList = join(repoRoot, "e2e/windows-known-issues.json");

test("every stated reason names a spec the suite really has", () => {
  const stated = JSON.parse(readFileSync(statedList, "utf8")) as KnownIssue[];
  for (const issue of stated) {
    const source = readFileSync(join(repoRoot, "e2e", issue.file), "utf8");
    expect(source, `${issue.file} has no test titled ${issue.title}`).toContain(issue.title);
    expect(issue.reason.length).toBeGreaterThan(0);
  }
});

const gate = (report: unknown, stated: unknown) => {
  const folder = mkdtempSync(join(tmpdir(), "mirador-verdict-"));
  const [reportPath, statedPath] = ["report.json", "stated.json"].map((name) => join(folder, name));
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(statedPath, JSON.stringify(stated));
  return Bun.spawnSync(["bun", join(repoRoot, "e2e/windows-suite-verdict.ts"), reportPath, statedPath], { cwd: repoRoot });
};

test("the gate lets a stated failure through and holds on one nobody explained", () => {
  const oneFailure = report({ file: "a.spec.ts", title: "breaks", status: "unexpected" });
  const explained = gate(oneFailure, [{ file: "a.spec.ts", title: "breaks", reason: "no such shell on Windows" }]);
  expect(explained.exitCode).toBe(0);
  expect(explained.stdout.toString()).toContain("no stated reason (0)");

  const mystery = gate(oneFailure, []);
  expect(mystery.exitCode).toBe(1);
  expect(mystery.stdout.toString()).toContain("a.spec.ts: breaks");
});

test("the gate holds when the suite was cut short: an error outside any test, a test stopped as it ran, or one that never ran with nothing failing before it", () => {
  const passing = { file: "a.spec.ts", title: "works", status: "expected" };
  const timedOut = { ...report(passing), errors: [{ message: "Timed out waiting 6000s for the test suite to run" }] };
  const outOfTime = gate(timedOut, []);
  expect(outOfTime.exitCode).toBe(1);
  expect(outOfTime.stdout.toString()).toContain("Timed out waiting 6000s for the test suite to run");

  const stopped = gate(report(passing, { file: "b.spec.ts", title: "running", status: "skipped", expectedStatus: "passed", results: [{ status: "interrupted" }] }), []);
  expect(stopped.exitCode).toBe(1);
  expect(stopped.stdout.toString()).toContain("Cut short as they ran (1):\n  b.spec.ts: running");

  const neverRan = gate(report(passing, { file: "c.spec.ts", title: "queued", status: "skipped", expectedStatus: "passed", results: [] }), []);
  expect(neverRan.exitCode).toBe(1);
  expect(neverRan.stdout.toString()).toContain("Never ran, with nothing in their file failing (1):\n  c.spec.ts: queued");
});

test("the gate lets through the specs a stated failure stopped its serial file before, and lists them", () => {
  const stoppedFile = report(
    { file: "serial.spec.ts", title: "first step", status: "unexpected" },
    { file: "serial.spec.ts", title: "second step", status: "skipped", expectedStatus: "passed", results: [{ status: "skipped" }] },
  );
  const verdict = gate(stoppedFile, [{ file: "serial.spec.ts", title: "first step", reason: "the model skips the tool" }]);
  expect(verdict.exitCode).toBe(0);
  expect(verdict.stdout.toString()).toContain("Not run, as an earlier failure in their file stopped it (1):\n  serial.spec.ts: second step");
});

test("the gate holds when the suite never got to run", () => {
  expect(gate({ suites: [] }, []).exitCode).toBe(1);
  expect(Bun.spawnSync(["bun", join(repoRoot, "e2e/windows-suite-verdict.ts"), "nope.json", "e2e/windows-known-issues.json"], { cwd: repoRoot }).exitCode).toBe(1);
});
