import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { excerptRows } from "../shared/review.ts";
import { ReviewProblems } from "../host/review/snapshot.ts";
import { snapshotTour, touredFileLines, type TourRequest } from "../host/review/tour.ts";

const made: string[] = [];
afterAll(() => made.forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function folderWith(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "mirador-tour-"));
  made.push(directory);
  Object.entries(files).forEach(([path, text]) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  });
  return directory;
}

const lines = (...each: string[]) => each.join("\n") + "\n";

/** A checkout with an app/ folder, where the task changed a line of service.ts and wrote new.ts and a gitignored file, none of it committed. */
function checkoutWithUncommittedWork() {
  const directory = folderWith({
    ".gitignore": "generated/\n",
    "readme.md": "# Top\n",
    "app/service.ts": lines("export function serve() {", "  return load();", "}", "", "function load() {", "  return 1;", "}"),
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(directory, "app/service.ts"), lines("export function serve() {", "  return load() + 1;", "}", "", "function load() {", "  return 1;", "}"));
  writeFileSync(join(directory, "app/new.ts"), lines("export const added = true;"));
  mkdirSync(join(directory, "app/generated"));
  writeFileSync(join(directory, "app/generated/out.ts"), lines("// generated", "export const out = 1;"));
  return { directory, git, head: git("rev-parse", "HEAD").trim() };
}

const request = (folder: string, change: Partial<TourRequest> = {}): TourRequest => ({
  title: "How serve works",
  folder,
  summary: "serve() adds one to load().",
  flow: [{ title: "Entry", at: "service.ts:1-3", say: "serve() calls load()." }],
  ...change,
});

async function problemsOf(tour: Promise<unknown>) {
  const error = await tour.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(ReviewProblems);
  return (error as ReviewProblems).problems;
}

describe("snapshotTour", () => {
  test("without since, each step shows its code as it is on disk, also in a folder outside git, and no changes", async () => {
    const folder = folderWith({ "notes/plan.ts": lines("const a = 1;", "const b = 2;", "const c = a + b;") });

    const tour = await snapshotTour(request(folder, { flow: [{ title: "Sum", at: "notes/plan.ts:3", say: "Adds them." }] }));

    expect(tour.changes).toBeNull();
    expect(tour.files).toEqual([]);
    expect(tour.flow[0]).toMatchObject({ title: "Sum", at: { path: "notes/plan.ts", line: 3, endLine: 3 }, excerpt: { startLine: 1, lines: ["const a = 1;", "const b = 2;", "const c = a + b;"] } });
  });

  test("with since HEAD, a tour of a subfolder shows the uncommitted changes and new files relative to it, marks them in its steps, and leaves the user's index alone", async () => {
    const { directory, git, head } = checkoutWithUncommittedWork();
    const folder = join(directory, "app");

    const tour = await snapshotTour(request(folder, { since: "HEAD" }));

    expect(tour.changes).toMatchObject({ since: "HEAD", sinceCommit: head });
    expect(tour.files.map(({ path, change }) => [path, change])).toEqual([
      ["new.ts", "added"],
      ["service.ts", "modified"],
    ]);
    const service = tour.files.find(({ path }) => path === "service.ts");
    expect(excerptRows(service, tour.flow[0]!.excerpt).map(({ kind, text }) => `${kind} ${text}`)).toContain("added   return load() + 1;");
    expect(excerptRows(service, tour.flow[0]!.excerpt).map(({ kind, text }) => `${kind} ${text}`)).toContain("removed   return load();");
    expect(await touredFileLines(tour, "service.ts")).toHaveLength(7);
    expect(git("status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M app/service.ts", "?? app/new.ts"]);
  });

  test("once git gc removes the snapshot, a changed file says so rather than failing with git's message", async () => {
    const { directory, git } = checkoutWithUncommittedWork();
    const tour = await snapshotTour(request(join(directory, "app"), { since: "HEAD" }));

    git("gc", "--quiet", "--prune=now");

    await expect(touredFileLines(tour, "service.ts")).rejects.toThrow("Git no longer has service.ts as it was when the tour was published");
  });

  test("with since, a step in a file git ignores still shows its code, read from disk", async () => {
    const { directory } = checkoutWithUncommittedWork();

    const tour = await snapshotTour(request(join(directory, "app"), { since: "HEAD", flow: [{ title: "Output", at: "generated/out.ts:2", say: "Built." }] }));

    expect(tour.flow[0]!.excerpt.lines).toEqual(["// generated", "export const out = 1;"]);
    expect(tour.files.map(({ path }) => path)).not.toContain("generated/out.ts");
  });

  test("every wrong anchor is reported in one go, a path outside the folder among them", async () => {
    const { directory } = checkoutWithUncommittedWork();

    const problems = await problemsOf(
      snapshotTour(
        request(join(directory, "app"), {
          flow: [
            { title: "Missing", at: "nowhere.ts:1", say: "?" },
            { title: "Past the end", at: "service.ts:99", say: "?" },
            { title: "No line", at: "service.ts", say: "?" },
            { title: "Outside", at: "../readme.md:1", say: "?" },
          ],
        }),
      ),
    );

    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('flow step 1 ("Missing"): nowhere.ts is not a file in ');
    expect(problems[1]).toContain("service.ts:99 is outside the file, which has 7 lines");
    expect(problems[2]).toContain('"service.ts" is not "path:line"');
    expect(problems[3]).toContain("../readme.md is not a file in ");
  });

  test("with since, a path out of the folder is reported even when the folder has a file of that name, and so is a folder", async () => {
    const { directory } = checkoutWithUncommittedWork();
    writeFileSync(join(directory, "app/readme.md"), "# App\n");
    mkdirSync(join(directory, "app/lib"));
    writeFileSync(join(directory, "app/lib/util.ts"), "export const util = 1;\n");

    const problems = await problemsOf(
      snapshotTour(
        request(join(directory, "app"), {
          since: "HEAD",
          flow: [
            { title: "Outside", at: "../readme.md:1", say: "?" },
            { title: "Folder", at: "lib:1", say: "?" },
          ],
        }),
      ),
    );

    expect(problems).toEqual([expect.stringContaining("../readme.md is not a file in "), expect.stringContaining("lib is not a file in ")]);
  });

  test("since in a folder outside git, a since that is no commit, or a folder that is no absolute path, each say what to fix", async () => {
    const outsideGit = folderWith({ "a.ts": "const a = 1;\n" });
    const { directory } = checkoutWithUncommittedWork();

    expect(await problemsOf(snapshotTour(request(outsideGit, { since: "HEAD", flow: [{ title: "A", at: "a.ts:1", say: "?" }] })))).toEqual([
      expect.stringContaining("is not inside a git checkout, so the tour cannot show what changed; leave since out."),
    ]);
    expect(await problemsOf(snapshotTour(request(join(directory, "app"), { since: "no-such-branch" })))).toEqual([`since: no-such-branch is not a commit in ${realpathSync(join(directory, "app"))}.`]);
    expect(await problemsOf(snapshotTour(request("app")))).toEqual(["folder: app is not an absolute path of a folder."]);
  });
});
