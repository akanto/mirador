import { existsSync } from "node:fs";
import { join } from "node:path";
import { isNewerVersion, releasePage, type NewerVersion } from "../shared/newer-version.ts";
import { MIRADOR_VERSION } from "../shared/version.ts";

const CHECK_EVERY_MILLISECONDS = 6 * 60 * 60 * 1000;
const GIVE_UP_AFTER_MILLISECONDS = 60_000;

/** Nobody is there to type a password or a key's passphrase, and a prompt would land in the terminal the host was started from. */
const environmentWithoutPrompts = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
});

async function git(directory: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", directory, ...args], {
    env: environmentWithoutPrompts(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: GIVE_UP_AFTER_MILLISECONDS,
  });
  const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} exited with ${exitCode}`);
  return output.trim();
}

/** Fetches only the branch the checkout follows, so refs that other tools keep on the same remote stay as they are. */
export async function newerCommits(checkout: string, fetching: boolean): Promise<NewerVersion | null> {
  const branch = await git(checkout, ["symbolic-ref", "--quiet", "HEAD"]);
  const [remote, remoteBranch, upstream] = (await git(checkout, ["for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)%09%(upstream:short)", branch])).split("\t");
  if (!remote || !remoteBranch || !upstream) return null;
  if (fetching) await git(checkout, ["fetch", "--quiet", "--no-tags", remote, remoteBranch]);
  const commits = Number(await git(checkout, ["rev-list", "--count", "HEAD..@{upstream}"]));
  if (commits === 0) return null;
  return { kind: "checkout", commits, upstream, upstreamCommit: await git(checkout, ["rev-parse", "@{upstream}"]) };
}

/** GitHub answers 404 while the repository is private or nothing is published yet, which leaves nothing to show. */
export async function newerRelease(latestReleaseUrl: string, current = MIRADOR_VERSION): Promise<NewerVersion | null> {
  const response = await fetch(latestReleaseUrl, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(GIVE_UP_AFTER_MILLISECONDS) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`the latest release answered ${response.status}`);
  const { tag_name: tag } = (await response.json()) as { tag_name?: unknown };
  if (typeof tag !== "string") return null;
  const version = tag.replace(/^v/, "");
  return isNewerVersion(version, current) ? { kind: "release", version, url: releasePage(tag) } : null;
}

/** A host with `.git` in its own source directory runs from a checkout; a release's copy of the source has none. */
export const newerVersionLookup = (sourceDir: string, latestReleaseUrl: string) =>
  existsSync(join(sourceDir, ".git")) ? (fetching: boolean) => newerCommits(sourceDir, fetching) : () => newerRelease(latestReleaseUrl);

/** Looks when started and every few hours; when it can't tell, offline for one, the last answer stands. */
export class NewerVersionWatcher {
  current: NewerVersion | null = null;
  private started = false;
  private timer?: ReturnType<typeof setInterval>;
  private looking: Promise<void> = Promise.resolve();

  constructor(
    private readonly lookup: (fetching: boolean) => Promise<NewerVersion | null>,
    private readonly changed: (newer: NewerVersion | null) => void,
  ) {}

  start() {
    this.started = true;
    this.look(true);
    this.timer = setInterval(() => this.look(true), CHECK_EVERY_MILLISECONDS);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** After a pull, without asking the remote again; a host that doesn't look, as test hosts don't, doesn't recount either. */
  recount() {
    if (this.started) this.look(false);
  }

  /** One look at a time, so a slow fetch can't finish after a later recount and bring back what that recount cleared. */
  look(fetching: boolean) {
    this.looking = this.looking.then(() => this.lookOnce(fetching));
    return this.looking;
  }

  private async lookOnce(fetching: boolean) {
    const found = await this.lookup(fetching).catch(() => this.current);
    if (JSON.stringify(found) === JSON.stringify(this.current)) return;
    this.current = found;
    this.changed(found);
  }
}
