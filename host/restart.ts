import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ConversationService } from "./conversations.ts";
import type { Hub } from "./hub.ts";

const STOPPED_TURNS_FILE = "turns-stopped-for-restart.json";
const SERVICES_STOP_TIMEOUT_MS = 5_000;

/** Settles once the services have stopped, or after `timeoutMs` if one of them hangs; a hanging stop is left running, not cancelled. */
export function stoppedWithinTimeout(stopServices: () => Promise<void>, timeoutMs = SERVICES_STOP_TIMEOUT_MS): Promise<void> {
  return Promise.race([stopServices(), Bun.sleep(timeoutMs)]);
}

/**
 * The command line the host was started with: `bun host/main.ts` from the source directory. Bun reports the entry as an
 * absolute path, but the desktop app recognises the host it started by this exact command line.
 */
export function hostCommandLine(argv0: string, entry: string, cwd: string, args: string[]) {
  return [argv0, relative(cwd, entry), ...args];
}

/** The conversations whose turns the previous host stopped to restart, so this one continues them. Read once. */
export function takeTurnsStoppedForRestart(dataDir: string): string[] {
  const path = join(dataDir, STOPPED_TURNS_FILE);
  if (!existsSync(path)) return [];
  const conversationIds = JSON.parse(readFileSync(path, "utf8")) as string[];
  rmSync(path);
  return conversationIds;
}

/** Tracks whether the host runs its current source, and restarts it in place when asked. */
export class HostRestart {
  codeChanged = false;
  private restarting = false;

  constructor(
    private readonly hub: Hub,
    private readonly conversations: ConversationService,
    private readonly dataDir: string,
    private readonly stopServices: () => Promise<void>,
  ) {}

  hostCodeEdited() {
    if (this.codeChanged) return;
    this.codeChanged = true;
    this.hub.broadcast({ type: "host.code-changed" });
  }

  /**
   * Running turns are stopped the way Stop does, so their agents can continue them after the restart. The process
   * re-executes itself rather than exiting, keeping its pid for whoever supervises it (the desktop app, launchd, a terminal).
   */
  async restart() {
    const reexecute = process.execve?.bind(process);
    if (!reexecute) throw new Error("This version of Bun cannot restart the host in place; restart it from the tray or the terminal instead.");
    if (this.restarting) return;
    this.restarting = true;
    console.log(`${new Date().toISOString()} restarting the host in place`);
    this.hub.broadcast({ type: "host.restarting" });
    const stoppedTurns = await this.conversations.prepareForRestart();
    writeFileSync(join(this.dataDir, STOPPED_TURNS_FILE), JSON.stringify(stoppedTurns), { mode: 0o600 });
    await stoppedWithinTimeout(this.stopServices);
    reexecute(process.execPath, hostCommandLine(process.argv0, Bun.main, process.cwd(), process.argv.slice(2)), process.env);
  }
}
