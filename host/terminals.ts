import type { Subprocess } from "bun";
import { basename } from "node:path";
import { MAX_TERMINALS_PER_TAB, type TerminalTab } from "../shared/model.ts";
import type { ServerMessage, TerminalSplit } from "../shared/protocol.ts";
import { splitTerminal, terminalsIn, withoutTerminal, type TerminalLayout } from "../shared/terminal-layout.ts";
import { agentEnvironment, loginShell } from "./acp/environment.ts";
import type { BrowserSocket, Hub } from "./hub.ts";

const SCROLLBACK_CHARACTERS = 256 * 1024;
const MAX_DIMENSION = 1_000;

const titleSequence = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

interface Shell {
  id: string;
  workspaceId: string;
  tabId: string;
  child: Subprocess;
  scrollback: string[];
  scrollbackLength: number;
  title: string | null;
}

/** A program to run in a terminal tab of its own instead of the login shell. */
export interface TerminalProgram {
  tabName: string;
  command: string[];
  environment: Record<string, string>;
}

interface Tab {
  id: string;
  workspaceId: string;
  name: string;
  /** Null only until its first terminal starts. */
  layout: TerminalLayout | null;
}

const terminalIdsOf = (tab: Tab) => (tab.layout ? terminalsIn(tab.layout) : []);

const dimension = (value: number) => Math.min(Math.max(1, Math.floor(value) || 1), MAX_DIMENSION);

const lastTitleIn = (text: string) => [...text.matchAll(titleSequence)].at(-1)?.[1];

/**
 * What runs in the foreground of the shell's terminal, or null while the shell itself waits at its prompt: the
 * terminal's foreground process group is then the shell's own.
 */
async function foregroundCommand(shellPid: number): Promise<string | null> {
  const groups = Bun.spawn(["ps", "-o", "tpgid=,pgid=", "-p", String(shellPid)], { stdout: "pipe", stderr: "ignore" });
  const [foregroundGroup, shellGroup] = (await new Response(groups.stdout).text()).trim().split(/\s+/);
  if (!foregroundGroup || foregroundGroup === shellGroup || Number(foregroundGroup) <= 0) return null;
  const command = Bun.spawn(["ps", "-o", "comm=", "-p", foregroundGroup], { stdout: "pipe", stderr: "ignore" });
  return basename((await new Response(command.stdout).text()).trim()) || "a command";
}

/**
 * Login shells on pseudo-terminals, started in a workspace's folder and grouped into tabs of splits, side by side and
 * one above the other.
 * They live in the host, so every window shows the same tabs and reloading the page reattaches to them (the recent
 * output is replayed); they end when the host stops. Their output is only ever sent to browsers, never logged or stored.
 */
export class TerminalService {
  private readonly shells = new Map<string, Shell>();
  private readonly tabs = new Map<string, Tab>();

  constructor(
    private readonly hub: Hub,
    private readonly workspacePath: (workspaceId: string) => string | undefined,
  ) {}

  attach(socket: BrowserSocket, workspaceId: string | null) {
    socket.data.terminalWorkspaceId = workspaceId;
    if (workspaceId) this.hub.send(socket, this.listing(workspaceId));
  }

  replay(socket: BrowserSocket, terminalId: string) {
    const shell = this.shells.get(terminalId);
    if (shell) this.hub.send(socket, { type: "terminal.replayed", terminalId, data: shell.scrollback.join("") });
  }

  /** Starts a shell in a new tab, or beside or below the terminal `split` names. */
  open(workspaceId: string, columns: number, rows: number, split: TerminalSplit | null = null) {
    const cwd = this.workspacePath(workspaceId);
    if (!cwd) throw new Error("This workspace no longer exists.");
    const tab = split ? this.splittableTabOf(split.terminalId) : this.newTab(workspaceId);
    const shell = this.spawn(workspaceId, tab.id, cwd, columns, rows);
    tab.layout = split && tab.layout ? splitTerminal(tab.layout, split.terminalId, shell.id, split.axis) : { terminalId: shell.id };
    this.tabs.set(tab.id, tab);
    this.publishListing(workspaceId);
    return { tabId: tab.id, terminalId: shell.id };
  }

  /** Runs `program` in a new tab; the tab closes when it exits. */
  openProgram(workspaceId: string, columns: number, rows: number, program: TerminalProgram) {
    const cwd = this.workspacePath(workspaceId);
    if (!cwd) throw new Error("This workspace no longer exists.");
    const tab = this.newTab(workspaceId, program.tabName);
    const shell = this.spawn(workspaceId, tab.id, cwd, columns, rows, program);
    tab.layout = { terminalId: shell.id };
    this.tabs.set(tab.id, tab);
    this.publishListing(workspaceId);
    return { tabId: tab.id, terminalId: shell.id, exited: shell.child.exited };
  }

  input(terminalId: string, data: string) {
    this.shells.get(terminalId)?.child.terminal?.write(data);
  }

  resize(terminalId: string, columns: number, rows: number) {
    this.shells.get(terminalId)?.child.terminal?.resize(dimension(columns), dimension(rows));
  }

  /** Forgets the output above the cursor's line, in every window and in what a reload replays, like ⌘K in a macOS terminal. */
  clear(terminalId: string) {
    const shell = this.shells.get(terminalId);
    if (!shell) return;
    const cursorLine = shell.scrollback.join("").split("\n").at(-1) ?? "";
    shell.scrollback = [cursorLine];
    shell.scrollbackLength = cursorLine.length;
    this.publish(shell.workspaceId, { type: "terminal.cleared", terminalId });
  }

  close(terminalId: string) {
    this.shells.get(terminalId)?.child.kill("SIGHUP");
  }

  /** Like iTerm2's ⌘W: a terminal at its shell's prompt closes, one running a command stays and the command is named. */
  async closeUnlessBusy(socket: BrowserSocket, terminalId: string) {
    const shell = this.shells.get(terminalId);
    if (!shell) return;
    const command = await foregroundCommand(shell.child.pid);
    if (command === null) this.close(terminalId);
    else this.hub.send(socket, { type: "terminal.busy", terminalId, command });
  }

  closeTab(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (tab) terminalIdsOf(tab).forEach((terminalId) => this.close(terminalId));
  }

  closeWorkspace(workspaceId: string) {
    this.shellsIn(workspaceId).forEach(({ id }) => this.close(id));
  }

  shutdown() {
    this.shells.forEach(({ id }) => this.close(id));
  }

  private splittableTabOf(terminalId: string) {
    const tab = this.tabs.get(this.shells.get(terminalId)?.tabId ?? "");
    if (!tab) throw new Error("That terminal is closed.");
    if (terminalIdsOf(tab).length >= MAX_TERMINALS_PER_TAB) throw new Error(`A tab holds at most ${MAX_TERMINALS_PER_TAB} terminals.`);
    return tab;
  }

  /** Named after the shell (or the program), numbered from 2 with the lowest number no open tab uses: zsh, zsh 2, zsh 3… */
  private newTab(workspaceId: string, baseName = basename(loginShell())): Tab {
    const taken = new Set(this.tabsIn(workspaceId).map(({ name }) => name));
    const numbered = (number: number) => (number === 1 ? baseName : `${baseName} ${number}`);
    let number = 1;
    while (taken.has(numbered(number))) number++;
    return { id: crypto.randomUUID(), workspaceId, name: numbered(number), layout: null };
  }

  private spawn(workspaceId: string, tabId: string, cwd: string, columns: number, rows: number, program?: TerminalProgram) {
    const decoder = new TextDecoder();
    const shell: Shell = { id: crypto.randomUUID(), workspaceId, tabId, child: undefined!, scrollback: [], scrollbackLength: 0, title: null };
    shell.child = Bun.spawn(program?.command ?? [loginShell(), "-l"], {
      cwd,
      env: { ...(program?.environment ?? agentEnvironment()), TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols: dimension(columns),
        rows: dimension(rows),
        data: (_terminal, bytes) => this.received(shell, decoder.decode(bytes, { stream: true })),
      },
    });
    this.shells.set(shell.id, shell);
    shell.child.exited.then((exitCode) => this.ended(shell, exitCode));
    return shell;
  }

  private received(shell: Shell, text: string) {
    if (!text) return;
    shell.scrollback.push(text);
    shell.scrollbackLength += text.length;
    while (shell.scrollbackLength > SCROLLBACK_CHARACTERS && shell.scrollback.length > 1) {
      shell.scrollbackLength -= shell.scrollback.shift()!.length;
    }
    this.publish(shell.workspaceId, { type: "terminal.output", terminalId: shell.id, data: text });
    this.retitle(shell, lastTitleIn(text));
  }

  private retitle(shell: Shell, title: string | undefined) {
    if (title === undefined || (title || null) === shell.title) return;
    shell.title = title || null;
    this.publishListing(shell.workspaceId);
  }

  private ended(shell: Shell, exitCode: number) {
    shell.child.terminal?.close();
    this.shells.delete(shell.id);
    this.removeFromTab(shell);
    this.publish(shell.workspaceId, { type: "terminal.exited", terminalId: shell.id, exitCode });
    this.publishListing(shell.workspaceId);
  }

  private removeFromTab(shell: Shell) {
    const tab = this.tabs.get(shell.tabId);
    if (!tab?.layout) return;
    tab.layout = withoutTerminal(tab.layout, shell.id);
    if (tab.layout === null) this.tabs.delete(tab.id);
  }

  private shellsIn(workspaceId: string) {
    return [...this.shells.values()].filter((shell) => shell.workspaceId === workspaceId);
  }

  private tabsIn(workspaceId: string) {
    return [...this.tabs.values()].filter((tab) => tab.workspaceId === workspaceId);
  }

  private listing(workspaceId: string): ServerMessage {
    const tabs: TerminalTab[] = this.tabsIn(workspaceId).flatMap((tab) =>
      tab.layout
        ? [{ id: tab.id, name: tab.name, layout: tab.layout, terminals: terminalIdsOf(tab).map((terminalId) => ({ id: terminalId, title: this.shells.get(terminalId)?.title ?? null })) }]
        : [],
    );
    return { type: "terminals.listed", workspaceId, tabs };
  }

  private publishListing(workspaceId: string) {
    this.publish(workspaceId, this.listing(workspaceId));
  }

  private publish(workspaceId: string, message: ServerMessage) {
    this.hub.publishWhere((socket) => socket.data.terminalWorkspaceId === workspaceId, message);
  }
}
