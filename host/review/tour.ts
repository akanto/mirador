import { copyFileSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ReviewFile, Tour, TourChanges } from "../../shared/review.ts";
import { hideUnreadableDiffs, parseGitDiff } from "./diff.ts";
import { AnchorReader, diskLines, git, gitOrProblem, linesAt, mapInOrder, pathInside, ReviewProblems, type LineSource } from "./snapshot.ts";

export interface TourRequest {
  title: string;
  folder: string;
  since?: string;
  summary: string;
  flow: { title: string; at: string; say: string }[];
}

const TOUR_NOT_SHOWN = "The tour was not shown. Fix these and call tour again";

function folderOrProblem(folder: string, problems: string[]) {
  if (!isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) {
    problems.push(`folder: ${folder} is not an absolute path of a folder.`);
    return null;
  }
  return realpathSync(folder);
}

/** The folder's files as they are now, untracked ones included, as a git tree of the whole checkout; the user's index stays as it was. */
async function workingTree(folder: string) {
  const scratch = mkdtempSync(join(tmpdir(), "mirador-tour-"));
  const index = join(scratch, "index");
  try {
    const usersIndex = (await git(folder, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    if (existsSync(usersIndex)) copyFileSync(usersIndex, index);
    await git(folder, ["add", "--all", "--", "."], { GIT_INDEX_FILE: index });
    return (await git(folder, ["write-tree"], { GIT_INDEX_FILE: index })).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function changesSince(folder: string, since: string, problems: string[]): Promise<{ changes: TourChanges; files: ReviewFile[] } | null> {
  const notInGit = () => `since: ${folder} is not inside a git checkout, so the tour cannot show what changed; leave since out.`;
  const prefix = await gitOrProblem(folder, ["rev-parse", "--show-prefix"], problems, notInGit);
  if (prefix === null) return null;
  const sinceCommit = (await gitOrProblem(folder, ["rev-parse", "--verify", `${since}^{commit}`], problems, () => `since: ${since} is not a commit in ${folder}.`))?.trim();
  if (!sinceCommit) return null;
  const tree = await workingTree(folder);
  const snapshot = (await gitOrProblem(folder, ["rev-parse", `${tree}:${prefix.trim()}`], problems, () => `since: git ignores everything in ${folder}, so the tour cannot show what changed; leave since out.`))?.trim();
  if (!snapshot) return null;
  const diff = await git(folder, ["diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3", "--relative", sinceCommit, tree]);
  return { changes: { since, sinceCommit, snapshot }, files: hideUnreadableDiffs(parseGitDiff(diff)) };
}

/**
 * Lines of the snapshot the changes were taken from, so the marks land on the right lines; files git ignores come from
 * disk. git reads a `../` path from the working directory, not from the snapshot, so paths are kept inside the folder first.
 */
const snapshotThenDisk = (folder: string, snapshot: string): LineSource => ({
  lines: async (path) => {
    const inside = pathInside(folder, path);
    if (!inside) return null;
    return (await linesAt(folder, snapshot, inside).catch(() => null)) ?? diskLines(folder).lines(inside);
  },
  where: `in ${folder}`,
});

/** The tour as the user will read it: each step's code as it was when published, and with `since`, what changed since then. */
export async function snapshotTour(request: TourRequest): Promise<Tour> {
  const problems: string[] = [];
  const folder = folderOrProblem(request.folder, problems);
  if (!folder) throw new ReviewProblems(problems, TOUR_NOT_SHOWN);
  const changed = request.since === undefined ? null : await changesSince(folder, request.since, problems);
  const anchors = new AnchorReader(folder, changed ? snapshotThenDisk(folder, changed.changes.snapshot) : diskLines(folder), problems);
  const flow = await mapInOrder(request.flow, async (step, index) => {
    const anchored = await anchors.read(step.at, `flow step ${index + 1} ("${step.title}")`);
    return anchored && { title: step.title, say: step.say, ...anchored };
  });
  if (problems.length > 0) throw new ReviewProblems(problems, TOUR_NOT_SHOWN);
  return {
    folder,
    changes: changed?.changes ?? null,
    summary: request.summary,
    flow: flow.filter((step) => step !== null),
    files: changed?.files ?? [],
  };
}

/** A changed file of the tour as it was published, so the page can show more of it than the diff does. */
export async function touredFileLines(tour: Tour, path: string) {
  const file = tour.files.find((candidate) => candidate.path === path);
  if (!file || file.change === "deleted" || !tour.changes) throw new Error(`${path} is not a file this tour shows changes of.`);
  return linesAt(tour.folder, tour.changes.snapshot, path).catch(() => {
    throw new Error(`Git no longer has ${path} as it was when the tour was published: git gc removes such copies after a while. The steps still show their lines.`);
  });
}
