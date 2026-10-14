import { checkInterval, describeJob, FAILED_CHECKS_BEFORE_GIVING_UP, jobEndedMessage, type JobWaitRequest } from "../shared/job-waits.ts";
import type { JobWait, JobWaitEnd, WaitedJob } from "../shared/model.ts";
import type { Store } from "./store.ts";
import type { TerminalProgram } from "./terminals.ts";

/** Appended to Claude Code's system prompt, so agents in Mirador hand their waiting to the host. */
export const jobWaitGuidance = `# Jobs left running
When a job will outlast your turn (a build, a test suite, a deploy, anything that takes more than a couple of minutes), start it with \`nohup <command> > <log> 2>&1 &\` and take its pid from \`$!\`, not with the Bash tool's run_in_background. Then run \`mirador when-done --pid <pid> "<message>"\` (or \`--container <name>\` for a Docker or Podman container; add \`--host <user@host>\` for a job on another machine, reached over ssh) and end your turn. Don't poll it with sleep and don't spawn an agent to watch it. The user follows your work in Mirador, which shows the jobs it waits for; a run_in_background job, and the harness waking you when it exits, don't show there. When the job ends, the message comes back to you as the user's next message, so write it as your instruction for picking up the work. Add \`--no-resume\` when the user should decide what happens next: Mirador then only tells them.`;

/** For the canvas server's when_done tool, which any agent can call: opencode gives its commands no session id that `mirador when-done` could name the conversation by. */
export const jobWaitToolDescription =
  "Have Mirador wait for a job you leave running, then send you a message. When a job will outlast your turn (a build, a test suite, a deploy, anything that takes more than a couple of minutes), start it with `nohup <command> > <log> 2>&1 &` and take its pid from `$!`, not with the Bash tool's run_in_background; or name its Docker or Podman container, and for a job on another machine its host. Then call this and end your turn. Don't poll it with sleep and don't spawn an agent to watch it. The user follows your work in Mirador, which shows the jobs it waits for; a run_in_background job, and the harness waking you when it exits, don't show there. When the job ends, the message comes back to you as the user's next message, so write it as your instruction for picking up the work. The same as the `mirador when-done` command.";

/** `unknown`: the check failed, e.g. ssh could not connect or Docker did not answer. */
export type JobState = "running" | "ended" | "unknown";

export type JobCheck = (wait: Pick<JobWait, "job" | "sshHost">) => Promise<JobState>;

export class JobWaitRefused extends Error {}

export interface JobWaitEvents {
  /** The conversation's waits changed: one was added, or one ended. */
  changed(conversationId: string): void;
  ended(conversationId: string, wait: JobWait, end: Exclude<JobWaitEnd, "stopped">): void;
}

interface Watched {
  conversationId: string;
  wait: JobWait;
  failedChecks: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Waits for jobs agents left running, checking each now and then; the waits are stored, so they go on after a host restart. */
export class JobWaits {
  private readonly watched = new Map<string, Watched>();
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly events: JobWaitEvents,
    private readonly check: JobCheck = checkJob,
    private readonly interval: (wait: JobWait) => number = checkInterval,
  ) {}

  /** Picks the stored waits back up, also after this instance stopped them: their old checks are dead, so they are watched anew. */
  startAll() {
    this.watched.forEach((watched) => clearTimeout(watched.timer));
    this.watched.clear();
    this.stopped = false;
    this.store.listJobWaits().forEach(({ conversationId, wait }) => this.watch(conversationId, wait));
  }

  /** Only for a job that runs now: a mistyped pid or container would otherwise end its wait at once. */
  async add(conversationId: string, { job, sshHost, message, resume }: JobWaitRequest): Promise<JobWait> {
    const state = await this.check({ job, sshHost });
    if (state === "ended") throw new JobWaitRefused(`There is no running ${describeJob({ job, sshHost })}.`);
    if (state === "unknown") throw new JobWaitRefused(`Mirador could not check ${describeJob({ job, sshHost })}${sshHost ? `: is ${sshHost} reachable with ssh, without a password prompt?` : "."}`);
    const wait: JobWait = { id: crypto.randomUUID(), job, sshHost, message: message ?? jobEndedMessage({ job, sshHost }), resume, since: Date.now() };
    this.store.addJobWait(conversationId, wait);
    this.watch(conversationId, wait);
    this.events.changed(conversationId);
    return wait;
  }

  in(conversationId: string): JobWait[] {
    return [...this.watched.values()].filter((watched) => watched.conversationId === conversationId).map(({ wait }) => wait);
  }

  /** The wait it stopped, unless it had already ended. */
  stop(conversationId: string, waitId: string): JobWait | undefined {
    const watched = this.watched.get(waitId);
    if (watched?.conversationId !== conversationId) return undefined;
    this.unwatch(watched);
    return watched.wait;
  }

  /** The conversation is gone, and its stored waits with it. */
  forget(conversationId: string) {
    [...this.watched.values()].filter((watched) => watched.conversationId === conversationId).forEach((watched) => this.cancel(watched));
  }

  /** For the host's stop: the waits stay stored for its next start. */
  stopAll() {
    this.stopped = true;
    this.watched.forEach((watched) => clearTimeout(watched.timer));
  }

  private watch(conversationId: string, wait: JobWait) {
    const watched: Watched = { conversationId, wait, failedChecks: 0 };
    this.watched.set(wait.id, watched);
    this.checkLater(watched);
  }

  private checkLater(watched: Watched) {
    watched.timer = setTimeout(() => void this.checkNow(watched), this.interval(watched.wait));
  }

  private async checkNow(watched: Watched) {
    const state = await this.check(watched.wait).catch((): JobState => "unknown");
    if (this.stopped || this.watched.get(watched.wait.id) !== watched) return;
    watched.failedChecks = state === "unknown" ? watched.failedChecks + 1 : 0;
    if (state === "ended") this.end(watched, "ended");
    else if (watched.failedChecks >= FAILED_CHECKS_BEFORE_GIVING_UP) this.end(watched, "gave-up");
    else this.checkLater(watched);
  }

  private end(watched: Watched, end: Exclude<JobWaitEnd, "stopped">) {
    this.unwatch(watched);
    this.events.ended(watched.conversationId, watched.wait, end);
  }

  private unwatch(watched: Watched) {
    this.cancel(watched);
    this.store.deleteJobWait(watched.wait.id);
    this.events.changed(watched.conversationId);
  }

  private cancel(watched: Watched) {
    clearTimeout(watched.timer);
    this.watched.delete(watched.wait.id);
  }
}

/** Whether a process of this machine runs; one of another user's that this host may not signal runs too. */
function processRuns(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A shell command printing running, ended or unknown. kill -0 fails on another user's process too, so ps has the last word.
 * A container that is gone, e.g. one started with --rm, has ended.
 */
export function jobCheckCommand(job: WaitedJob) {
  if (job.kind === "process") return `if kill -0 ${job.pid} 2>/dev/null || ps -p ${job.pid} >/dev/null 2>&1; then echo running; else echo ended; fi`;
  return [
    "engine=$(command -v docker || command -v podman) || { echo unknown; exit; }",
    `state=$("$engine" inspect --type container -f '{{.State.Running}}' ${job.name} 2>&1)`,
    'case "$state" in *[Nn]"o such"* | *false) echo ended ;; *true) echo running ;; *) echo unknown ;; esac',
  ].join("; ");
}

const SSH_FAILED = 255;
/** A check that hangs, e.g. on a stuck Docker, counts as failed rather than holding up the next. */
const CHECK_TIMEOUT_MS = 30_000;

const jobStateIn = (output: string): JobState => {
  const state = output.trim().split("\n").at(-1);
  return state === "running" || state === "ended" ? state : "unknown";
};

export async function checkJob({ job, sshHost }: Pick<JobWait, "job" | "sshHost">): Promise<JobState> {
  if (job.kind === "process" && !sshHost) return processRuns(job.pid) ? "running" : "ended";
  const command = sshHost
    ? ["ssh", "-o", "BatchMode=yes", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "--", sshHost, jobCheckCommand(job)]
    : ["sh", "-c", jobCheckCommand(job)];
  const checking = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: CHECK_TIMEOUT_MS });
  const [output, exitCode] = await Promise.all([new Response(checking.stdout).text(), checking.exited]);
  return exitCode === SSH_FAILED ? "unknown" : jobStateIn(output);
}

const singleQuoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The tab goes when its program exits, so what the program said last waits for Enter. */
const closeOnEnter = "printf 'Press Enter to close this tab.'; read -r _";

const stopFollowingOnceCaughtUp = '[ -n "${follower-}" ] && { sleep 1; kill $follower 2>/dev/null; }';

/**
 * A process's output is the file its stdout or stderr goes to, as nohup and `> log 2>&1` leave it; one going to a
 * terminal or a pipe cannot be followed. /proc has the files on Linux, lsof on macOS.
 */
function followProcessScript(pid: number) {
  return [
    `pid=${pid}`,
    "runs() { kill -0 $pid 2>/dev/null || ps -p $pid >/dev/null 2>&1; }",
    `runs || { echo "Process $pid is not running."; ${closeOnEnter}; exit 1; }`,
    'echo "Command: $(ps -o args= -p $pid)"',
    `echo "Running for: $(ps -o etime= -p $pid | tr -d ' ')"`,
    "outputFile() { readlink /proc/$pid/fd/$1 2>/dev/null || lsof -a -p $pid -d $1 -Fn 2>/dev/null | sed -n 's/^n//p'; }",
    "set --",
    'for fd in 1 2; do file=$(outputFile $fd); if [ -f "$file" ] && [ -r "$file" ] && [ "$file" != "${1-}" ]; then set -- "$@" "$file"; fi; done',
    'if [ $# -gt 0 ]; then echo "Output: $*"; echo; tail -n 50 -f "$@" & follower=$!; else echo "Its output goes to no file this tab can follow, so it only shows when the process ends."; fi',
    `trap '[ -n "\${follower-}" ] && kill $follower 2>/dev/null; exit 130' INT TERM HUP`,
    "while runs; do sleep 1; done",
    stopFollowingOnceCaughtUp,
    'echo; echo "Process $pid ended."',
    closeOnEnter,
  ].join("\n");
}

function followContainerScript(name: string) {
  const inspect = (format: string) => `"$engine" inspect --type container -f ${singleQuoted(format)} ${name}`;
  return [
    `engine=$(command -v docker || command -v podman) || { echo "Neither docker nor podman is installed here."; ${closeOnEnter}; exit 1; }`,
    `${inspect("Image: {{.Config.Image}}")} || { ${closeOnEnter}; exit 1; }`,
    inspect("Command: {{.Path}}{{range .Args}} {{.}}{{end}}"),
    inspect("Started: {{.State.StartedAt}}"),
    "echo",
    `"$engine" logs --tail 50 -f ${name}`,
    `echo; echo "Container ${name} ended."`,
    closeOnEnter,
  ].join("\n");
}

/** A shell script that prints what the job runs and since when, then follows its output until it ends. */
const followJobScript = (job: WaitedJob) => (job.kind === "process" ? followProcessScript(job.pid) : followContainerScript(job.name));

/** Without BatchMode, unlike the checks: in a terminal, ssh can ask for a password. When it cannot connect, its error stays. */
function overSsh(sshHost: string, script: string) {
  const ssh = ["ssh", "-t", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10", "--", sshHost, `sh -c ${singleQuoted(script)}`];
  return `${ssh.map(singleQuoted).join(" ")}; [ $? -ne ${SSH_FAILED} ] || { ${closeOnEnter}; }`;
}

export function followJobProgram(wait: Pick<JobWait, "job" | "sshHost">): TerminalProgram {
  const script = followJobScript(wait.job);
  const job = describeJob(wait);
  return { tabName: job, key: `follow ${job}`, command: ["sh", "-c", wait.sshHost ? overSsh(wait.sshHost, script) : script] };
}
