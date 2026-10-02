/**
 * Posts made-up findings to a real pull request's pending review the way Mirador does, checks where GitHub put them,
 * then deletes the pending review again. Refuses a pull request where the user already has a pending review, so
 * their own draft is never touched.
 *
 *   bun scripts/check-review-posting.ts https://github.com/owner/repo/pull/123
 */
import { parseGitDiff } from "../host/review/diff.ts";
import { ghCli, parsePullRequestUrl, postPendingReview } from "../host/review/github.ts";
import type { DiffHunk, Review, ReviewFile, ReviewFinding } from "../shared/review.ts";

const url = process.argv[2];
if (!url) throw new Error("Usage: bun scripts/check-review-posting.ts <pull request URL>");
const pr = parsePullRequestUrl(url);
const api = (path: string, method = "GET") => ghCli(["api", "--hostname", pr.host, "--method", method, `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}${path}`]);

interface RestReview {
  id: number;
  node_id: string;
  state: string;
}
interface PostedComment {
  path: string;
  line: number | null;
  startLine: number | null;
  body: string;
}
const COMMENTS = `query($id: ID!) { node(id: $id) { ... on PullRequestReview { comments(first: 20) { nodes { path line startLine body } } } } }`;

const pendingReviews = async () => ((await api("/reviews?per_page=100")) as RestReview[]).filter(({ state }) => state === "PENDING");
if ((await pendingReviews()).length > 0) throw new Error("You already have a pending review on this pull request; not touching it.");

const diff = Bun.spawnSync(["gh", "pr", "diff", pr.url]);
if (diff.exitCode !== 0) throw new Error(diff.stderr.toString());
const files = parseGitDiff(diff.stdout.toString());
const headCommit = ((await api("")) as { head: { sha: string } }).head.sha;

const newSideLines = (hunk: DiffHunk) => hunk.rows.flatMap((row) => (row.newLine === null ? [] : [row.newLine]));
const hunkWithRoom = (file: ReviewFile) => file.hunks.find((hunk) => newSideLines(hunk).length >= 3);
const file = files.find((candidate) => hunkWithRoom(candidate));
if (!file) throw new Error("No hunk with three lines on the new side.");
const [first, second, third] = newSideLines(hunkWithRoom(file)!);
const lastLineOfDiff = Math.max(...file.hunks.flatMap(newSideLines));

const finding = (id: string, line: number, endLine: number, body: string): ReviewFinding => ({
  id,
  severity: "nit",
  checked: "plausible",
  at: { path: file.path, line, endLine },
  title: id,
  body,
  excerpt: { startLine: line, lines: [] },
  decision: "keep",
});
const review: Review = {
  repository: "/nowhere",
  base: "base",
  baseCommit: "",
  headCommit,
  pullRequest: pr,
  verdict: "",
  summary: "",
  flow: [],
  findings: [
    finding("single", first!, first!, "Mirador posting check: one line. This pending review is deleted right after."),
    finding("range", second!, third!, "Mirador posting check: a range of lines."),
    finding("outside", lastLineOfDiff + 500, lastLineOfDiff + 500, "Must not be posted: outside the diff."),
  ],
  files,
  posting: false,
  pendingReviewUrl: null,
};

const report = (label: string, value: unknown) => console.log(`${label}: ${JSON.stringify(value)}`);
let created: RestReview | undefined;
try {
  const firstPost = await postPendingReview(review, ghCli);
  report("first post: threads", [...firstPost.threadIds.keys()]);
  report("first post: errors", Object.fromEntries(firstPost.errors));
  created = (await pendingReviews())[0];
  if (!created) throw new Error("No pending review after posting.");

  const posted = new Set(firstPost.threadIds.keys());
  const again = { ...review, findings: [...review.findings.map((it) => (posted.has(it.id) ? { ...it, postedAs: { threadId: "x" } } : it)), finding("later", first!, first!, "Mirador posting check: added to the same pending review.")] };
  const secondPost = await postPendingReview(again, ghCli);
  report("second post: threads", [...secondPost.threadIds.keys()]);
  report("second post: errors", Object.fromEntries(secondPost.errors));
  report("pending reviews now", (await pendingReviews()).map(({ id }) => id));
  report("same review reused", secondPost.pendingReviewUrl === firstPost.pendingReviewUrl);

  const answer = (await ghCli(["api", "--hostname", pr.host, "graphql"], { query: COMMENTS, variables: { id: created.node_id } })) as { data: { node: { comments: { nodes: PostedComment[] } } } };
  report("expected", { path: file.path, single: first, range: [second, third] });
  answer.data.node.comments.nodes.forEach(({ path, line, startLine, body }) => report("on GitHub", { path, startLine, line, body: body.slice(0, 40) }));
} finally {
  const leftOver = created ? [created] : await pendingReviews();
  for (const pending of leftOver) {
    await api(`/reviews/${pending.id}`, "DELETE");
    report("deleted pending review", pending.id);
  }
  report("pending reviews left", (await pendingReviews()).length);
}
