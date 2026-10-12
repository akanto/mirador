import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excerptRows, isCommentable, parseAnchor, type Review, type ReviewFile } from "../shared/review.ts";
import { hideUnreadableDiffs, parseGitDiff } from "../host/review/diff.ts";
import { parsePullRequestUrl, postPendingReview, type GitHubCli } from "../host/review/github.ts";
import { AnchorReader, ReviewProblems, snapshotReview } from "../host/review/snapshot.ts";
import { gitRepository, reviewRequest as request } from "./review-repository.ts";

const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,5 @@ export function start() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
--- not a header, a removed line
 const e = 6;
diff --git a/README.md b/docs/README.md
similarity index 90%
rename from README.md
rename to docs/README.md
diff --git a/new file.txt b/new file.txt
new file mode 100644
--- /dev/null
+++ b/new file.txt
@@ -0,0 +1 @@
+hello
\\ No newline at end of file
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`;

/** A fresh repo holding just the named file, committed, then given the change; its `git diff HEAD`. */
function diffOf(file: string, change: "deleted" | "mode" | "modified") {
  const directory = mkdtempSync(join(tmpdir(), "mirador-quoted-paths-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(directory, file), "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  if (change === "deleted") git("rm", "-q", "--", file);
  else if (change === "mode") chmodSync(join(directory, file), 0o755);
  else writeFileSync(join(directory, file), "y\n");
  return git("diff", "HEAD");
}

describe("parseGitDiff", () => {
  test("keeps C-quoted paths whole when only the diff header carries them, deleted or mode-only", () => {
    expect(parseGitDiff(diffOf('we"ird\\name.txt', "deleted")).map(({ path, change }) => [path, change])).toEqual([['we"ird\\name.txt', "deleted"]]);
    expect(parseGitDiff(diffOf('we"ird\\name.txt', "mode")).map(({ path, hunks }) => [path, hunks.length])).toEqual([['we"ird\\name.txt', 0]]);
  });

  test("turns git's octal escapes back into the characters they spell", () => {
    expect(parseGitDiff(diffOf("café.txt", "deleted")).map(({ path, change }) => [path, change])).toEqual([["café.txt", "deleted"]]);
    expect(parseGitDiff(diffOf("café.txt", "modified")).map(({ path, change }) => [path, change])).toEqual([["café.txt", "modified"]]);
  });

  test("reads files, their kind of change, and hunks with both sides' line numbers", () => {
    const files = parseGitDiff(diff);
    expect(files.map(({ path, change, added, removed }) => [path, change, added, removed])).toEqual([
      ["src/app.ts", "modified", 2, 2],
      ["docs/README.md", "renamed", 0, 0],
      ["new file.txt", "added", 1, 0],
      ["logo.png", "modified", 0, 0],
      ["gone.ts", "deleted", 0, 2],
    ]);
    const [app] = files;
    expect(app!.hunks[0]!.header).toBe("export function start() {");
    expect(app!.hunks[0]!.rows).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
      { kind: "removed", oldLine: 2, newLine: null, text: "const b = 2;" },
      { kind: "added", oldLine: null, newLine: 2, text: "const b = 3;" },
      { kind: "added", oldLine: null, newLine: 3, text: "const c = 4;" },
      { kind: "context", oldLine: 3, newLine: 4, text: "const d = 5;" },
      { kind: "removed", oldLine: 4, newLine: null, text: "-- not a header, a removed line" },
      { kind: "context", oldLine: 5, newLine: 5, text: "const e = 6;" },
    ]);
    expect(files[1]!.oldPath).toBe("README.md");
    expect(files[3]!.hiddenBecause).toBe("binary file");
  });

  test("leaves out lock files and diffs too long to read, keeping their counts", () => {
    const lockFile: ReviewFile = { ...parseGitDiff(diff)[0]!, path: "web/bun.lock" };
    const [hidden] = hideUnreadableDiffs([lockFile]);
    expect(hidden).toMatchObject({ hiddenBecause: "generated file", hunks: [], added: 2, removed: 2 });
  });
});

describe("anchors and excerpts", () => {
  const [app] = parseGitDiff(diff);

  test("an anchor is a path and a line or a range", () => {
    expect(parseAnchor("src/a:b.ts:12")).toEqual({ path: "src/a:b.ts", line: 12, endLine: 12 });
    expect(parseAnchor(" src/app.ts:3-9 ")).toEqual({ path: "src/app.ts", line: 3, endLine: 9 });
    expect(parseAnchor("src/app.ts")).toBeNull();
  });

  test("an excerpt of the new version shows added lines, and removed lines where they were", () => {
    const rows = excerptRows(app, { startLine: 1, lines: ["const a = 1;", "const b = 3;", "const c = 4;", "const d = 5;", "const e = 6;"] });
    expect(rows.map(({ kind, text }) => `${kind[0]} ${text}`)).toEqual([
      "c const a = 1;",
      "r const b = 2;",
      "a const b = 3;",
      "a const c = 4;",
      "c const d = 5;",
      "r -- not a header, a removed line",
      "c const e = 6;",
    ]);
  });

  test("a trailing deletion in a hunk with no new-side rows sits after the line git counted from", () => {
    const deletionOnly: ReviewFile = {
      path: "tail.ts",
      oldPath: null,
      change: "modified",
      added: 0,
      removed: 1,
      hunks: [{ header: "@@ -5 +4,0 @@", newStart: 4, rows: [{ kind: "removed", oldLine: 5, newLine: null, text: "gone" }] }],
      hiddenBecause: null,
    };
    const rows = excerptRows(deletionOnly, { startLine: 3, lines: ["three", "four", "five"] });
    expect(rows.map(({ kind, text }) => `${kind} ${text}`)).toEqual(["context three", "context four", "removed gone", "context five"]);
  });

  test("GitHub takes comments on lines in its diff's hunks, and a range only within one hunk", () => {
    expect(isCommentable(app, { path: "src/app.ts", line: 2, endLine: 3 })).toBe(true);
    expect(isCommentable(app, { path: "src/app.ts", line: 5, endLine: 6 })).toBe(false);
    expect(isCommentable(undefined, { path: "elsewhere.ts", line: 1, endLine: 1 })).toBe(false);
  });
});

describe("excerpt budget", () => {
  const fileLines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  const excerptOf = async (lines: string[], range: string) => {
    const reader = new AnchorReader("/repo", { lines: async () => lines, where: "in the test file" }, []);
    return (await reader.read(`big.ts:${range}`, "finding 1"))!.excerpt;
  };

  test("a short anchor keeps six lines of context on each side", async () => {
    expect(await excerptOf(fileLines(40), "10-12")).toEqual({ startLine: 4, lines: fileLines(40).slice(3, 18) });
  });

  test("an anchor that fits only when the context is dropped keeps every anchored line", async () => {
    expect(await excerptOf(fileLines(200), "1-160")).toEqual({ startLine: 1, lines: fileLines(160) });
  });

  test("an anchor longer than the cap keeps its first and its last line", async () => {
    const excerpt = await excerptOf(fileLines(300), "1-300");
    expect(excerpt.lines[0]).toBe("line 1");
    expect(excerpt.lines.at(-1)).toBe("line 300");
  });

  test("an anchor longer than the cap says how many of its lines are left out", async () => {
    const excerpt = await excerptOf(fileLines(300), "1-300");
    expect(excerpt.elision).toEqual({ after: 78, lineCount: 141 });
    expect(excerpt.lines.length).toBe(159);
    expect(excerpt.lines[79]).toBe("line 221");
  });

  test("the excerpt's line numbers jump over the elision", () => {
    const rows = excerptRows(undefined, { startLine: 500, lines: ["a", "b", "c", "d"], elision: { after: 1, lineCount: 40 } });
    expect(rows.map(({ kind, newLine }) => (kind === "elided" ? "elided" : newLine))).toEqual([500, 501, "elided", 542, 543]);
    expect(rows[2]!.text).toBe("… 40 lines not shown …");
  });

  test("a gap of one line says so in the singular", () => {
    const rows = excerptRows(undefined, { startLine: 10, lines: ["a", "b"], elision: { after: 0, lineCount: 1 } });
    expect(rows[1]!.text).toBe("… 1 line not shown …");
  });
});

describe("snapshotReview", () => {
  test("takes the diff from git and anchors the tour and findings in the reviewed version", async () => {
    const { directory, head } = gitRepository();
    const review = await snapshotReview(request(join(directory, "."), { pullRequest: "https://github.example.com/acme/shop/pull/7/files" }));
    expect(review).toMatchObject({ headCommit: head, base: "main", pullRequest: { host: "github.example.com", owner: "acme", repo: "shop", number: 7 } });
    expect(review.files.map(({ path, added, removed }) => [path, added, removed])).toEqual([["service.ts", 1, 1]]);
    expect(review.flow[0]!.excerpt).toEqual({ startLine: 1, lines: ["export function serve() {", "  return load() + 1;", "}", "", "function load() {", "  return 1;", "}"] });
    expect(review.findings[0]).toMatchObject({ id: "finding-1", decision: "keep", at: { path: "service.ts", line: 2, endLine: 2 } });
  });

  test("accepts absolute paths inside the checkout, and lists every wrong anchor at once", async () => {
    const { directory } = gitRepository();
    const absolute = await snapshotReview(request(directory, { flow: [{ title: "Entry", at: join(directory, "service.ts:5"), say: "load" }] }));
    expect(absolute.flow[0]!.at.path).toBe("service.ts");

    const wrong = request(directory, {
      flow: [{ title: "Gone", at: "missing.ts:1", say: "?" }],
      findings: [
        { severity: "issue", checked: "plausible", at: "service.ts:99", title: "Past the end", body: "?" },
        { severity: "issue", checked: "plausible", at: "service.ts", title: "No line", body: "?" },
      ],
    });
    const problems = await snapshotReview(wrong).catch((error: ReviewProblems) => error.problems);
    expect(problems).toEqual([
      expect.stringContaining('flow step 1 ("Gone"): missing.ts is not a file in the reviewed version'),
      'finding 1 ("Past the end"): service.ts:99 is outside the file, which has 7 lines.',
      'finding 2 ("No line"): "service.ts" is not "path:line" or "path:start-end".',
    ]);
  });

  test("names a base or repository that git does not know", async () => {
    const { directory } = gitRepository();
    expect(await snapshotReview(request(directory, { base: "nope" })).catch((error: ReviewProblems) => error.problems)).toEqual([
      expect.stringContaining("base: nope has no common history"),
    ]);
    expect(await snapshotReview(request(tmpdir())).catch((error: ReviewProblems) => error.problems)).toEqual([expect.stringContaining("is not inside a git checkout")]);
  });
});

describe("posting to the pull request", () => {
  test("reads pull request URLs, also of GitHub Enterprise and with a tab after the number", () => {
    expect(parsePullRequestUrl("https://github.infra.example.com/team/repo/pull/123/files")).toEqual({
      url: "https://github.infra.example.com/team/repo/pull/123",
      host: "github.infra.example.com",
      owner: "team",
      repo: "repo",
      number: 123,
    });
    expect(() => parsePullRequestUrl("https://github.com/team/repo/issues/1")).toThrow("is not a pull request URL");
  });

  const reviewOf = (headCommit: string): Review => {
    const [app] = parseGitDiff(diff);
    const finding = (id: string, line: number, endLine = line) => ({
      id,
      severity: "issue" as const,
      checked: "confirmed" as const,
      at: { path: "src/app.ts", line, endLine },
      title: id,
      body: `About ${id}`,
      excerpt: { startLine: 1, lines: [] },
      decision: "keep" as const,
    });
    return {
      repository: "/repo",
      base: "main",
      baseCommit: "base",
      headCommit,
      pullRequest: parsePullRequestUrl("https://ghe.example.com/team/repo/pull/5"),
      verdict: "",
      summary: "",
      flow: [],
      findings: [finding("finding-1", 2, 3), { ...finding("finding-2", 4), decision: "drop" }, finding("finding-3", 5), finding("finding-4", 40)],
      files: [app!],
      posting: false,
      pendingReviewUrl: null,
    };
  };

  /** Only the user's own pending review is ever pending for them. */
  function fakeGitHub(responses: { head: string; reviews: object[]; refuse?: string }) {
    const calls: { args: string[]; body?: any }[] = [];
    const gh: GitHubCli = async (args, body: any) => {
      calls.push({ args, body });
      const endpoint = args[3]!;
      if (endpoint === "repos/team/repo/pulls/5") return { node_id: "PR_node", head: { sha: responses.head } };
      if (body.query.includes("states: PENDING")) {
        expect(body.variables).toEqual({ owner: "team", repo: "repo", number: 5 });
        const pending = responses.reviews.filter((review: any) => review.state === "PENDING");
        return { data: { repository: { pullRequest: { reviews: { nodes: pending.map((review: any) => ({ id: review.node_id, url: review.html_url })) } } } } };
      }
      if (body.query.includes("addPullRequestReview(")) return { data: { addPullRequestReview: { pullRequestReview: { id: "PRR_new", url: "https://ghe.example.com/review/new" } } } };
      if (body.variables.input.path === responses.refuse) return { errors: [{ message: "Line could not be resolved" }] };
      return { data: { addPullRequestReviewThread: { thread: { id: `thread-${body.variables.input.line}` } } } };
    };
    return { gh, calls };
  }

  test("starts a pending review and adds each kept finding on the diff as a comment on it", async () => {
    const { gh, calls } = fakeGitHub({ head: "abc", reviews: [{ state: "COMMENTED", node_id: "old", html_url: "x" }], refuse: "nothing" });
    const outcome = await postPendingReview(reviewOf("abc"), gh);
    expect(calls.every(({ args }) => args.slice(0, 3).join(" ") === "api --hostname ghe.example.com")).toBe(true);
    expect(calls[2]!.body.variables.input).toEqual({ pullRequestId: "PR_node", commitOID: "abc" });
    expect(calls.slice(3).map(({ body }) => body.variables.input)).toEqual([
      { pullRequestReviewId: "PRR_new", path: "src/app.ts", line: 3, side: "RIGHT", startLine: 2, startSide: "RIGHT", body: "About finding-1" },
      { pullRequestReviewId: "PRR_new", path: "src/app.ts", line: 5, side: "RIGHT", body: "About finding-3" },
    ]);
    expect(outcome.pendingReviewUrl).toBe("https://ghe.example.com/review/new");
    expect([...outcome.threadIds]).toEqual([
      ["finding-1", "thread-3"],
      ["finding-3", "thread-5"],
    ]);
  });

  test("adds to the pending review the user already has, and reports the comments GitHub refused", async () => {
    const { gh, calls } = fakeGitHub({ head: "abc", reviews: [{ state: "PENDING", node_id: "PRR_mine", html_url: "https://ghe.example.com/review/mine" }], refuse: "src/app.ts" });
    const outcome = await postPendingReview(reviewOf("abc"), gh);
    expect(calls.some(({ body }) => body?.query.includes("addPullRequestReview("))).toBe(false);
    expect(outcome.pendingReviewUrl).toBe("https://ghe.example.com/review/mine");
    expect([...outcome.errors.keys()]).toEqual(["finding-1", "finding-3"]);
    expect(outcome.errors.get("finding-1")).toBe("Line could not be resolved");
  });

  test("finds the user's pending review on a pull request with more than a hundred reviews", async () => {
    const older = Array.from({ length: 120 }, (_, index) => ({ state: "COMMENTED", node_id: `old-${index}`, html_url: "x" }));
    const { gh, calls } = fakeGitHub({ head: "abc", reviews: [...older, { state: "PENDING", node_id: "PRR_mine", html_url: "https://ghe.example.com/review/mine" }] });
    const outcome = await postPendingReview(reviewOf("abc"), gh);
    expect(calls.some(({ body }) => body?.query.includes("addPullRequestReview("))).toBe(false);
    expect(outcome.pendingReviewUrl).toBe("https://ghe.example.com/review/mine");
  });

  test("refuses when the pull request moved on since the review", async () => {
    const { gh } = fakeGitHub({ head: "newer", reviews: [] });
    expect(postPendingReview(reviewOf("abc"), gh)).rejects.toThrow("The pull request has changed since the review");
  });
});
