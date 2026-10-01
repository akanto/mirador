import type { Subprocess } from "bun";
import { basename } from "node:path";
import { MAX_TERMINALS_PER_TAB, type TerminalTab } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
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

interface Tab {
  id: string;
  workspaceId: string;
  name: string;
  terminalIds: string[];
}

const dimension = (value: number) => Math.min(Math.max(1, Math.floor(value) || 1), MAX_DIMENSION);

const lastTitleIn = (text: string) => [...text.matchAll(titleSequence)].at(-1)?.[1];

/**
 * Login shells on pseudo-terminals, started in a workspace's folder and grouped into tabs of side-by-side splits.
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

  /** Starts a shell in a new tab, or as another split of `tabId`. */
  open(workspaceId: string, columns: number, rows: number, tabId: string | null = null) {
    const cwd = this.workspacePath(workspaceId);
    if (!cwd) throw new Error("This workspace no longer exists.");
    const existingTab = tabId === null ? null : this.splittableTab(tabId);
    const tab = existingTab ?? this.newTab(workspaceId);
    const shell = this.spawn(workspaceId, tab.id, cwd, columns, rows);
    tab.terminalIds.push(shell.id);
    this.tabs.set(tab.id, tab);
    this.publishListing(workspaceId);
    return { tabId: tab.id, terminalId: shell.id };
  }

  input(terminalId: string, data: string) {
    this.shells.get(terminalId)?.child.terminal?.write(data);
  }

  resize(terminalId: string, columns: number, rows: number) {
    this.shells.get(terminalId)?.child.terminal?.resize(dimension(columns), dimension(rows));
  }

  close(terminalId: string) {
    this.shells.get(terminalId)?.child.kill("SIGHUP");
  }

  closeTab(tabId: string) {
    this.tabs.get(tabId)?.terminalIds.forEach((terminalId) => this.close(terminalId));
  }

  closeWorkspace(workspaceId: string) {
    this.shellsIn(workspaceId).forEach(({ id }) => this.close(id));
  }

  shutdown() {
    this.shells.forEach(({ id }) => this.close(id));
  }

  private splittableTab(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("That terminal tab is closed.");
    if (tab.terminalIds.length >= MAX_TERMINALS_PER_TAB) throw new Error(`A tab holds at most ${MAX_TERMINALS_PER_TAB} terminals.`);
    return tab;
  }

  /** Named after the shell, numbered from 2 with the lowest number no open tab uses: zsh, zsh 2, zsh 3… */
  private newTab(workspaceId: string): Tab {
    const shellName = basename(loginShell());
    const taken = new Set(this.tabsIn(workspaceId).map(({ name }) => name));
    const numbered = (number: number) => (number === 1 ? shellName : `${shellName} ${number}`);
    let number = 1;
    while (taken.has(numbered(number))) number++;
    return { id: crypto.randomUUID(), workspaceId, name: numbered(number), terminalIds: [] };
  }

  private spawn(workspaceId: string, tabId: string, cwd: string, columns: number, rows: number) {
    const decoder = new TextDecoder();
    const shell: Shell = { id: crypto.randomUUID(), workspaceId, tabId, child: undefined!, scrollback: [], scrollbackLength: 0, title: null };
    shell.child = Bun.spawn([loginShell(), "-l"], {
      cwd,
      env: { ...agentEnvironment(), TERM: "xterm-256color", COLORTERM: "truecolor" },
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
    if (!tab) return;
    tab.terminalIds = tab.terminalIds.filter((terminalId) => terminalId !== shell.id);
    if (tab.terminalIds.length === 0) this.tabs.delete(tab.id);
  }

  private shellsIn(workspaceId: string) {
    return [...this.shells.values()].filter((shell) => shell.workspaceId === workspaceId);
  }

  private tabsIn(workspaceId: string) {
    return [...this.tabs.values()].filter((tab) => tab.workspaceId === workspaceId);
  }

  private listing(workspaceId: string): ServerMessage {
    const tabs: TerminalTab[] = this.tabsIn(workspaceId).map(({ id, name, terminalIds }) => ({
      id,
      name,
      terminals: terminalIds.map((terminalId) => ({ id: terminalId, title: this.shells.get(terminalId)?.title ?? null })),
    }));
    return { type: "terminals.listed", workspaceId, tabs };
  }

  private publishListing(workspaceId: string) {
    this.publish(workspaceId, this.listing(workspaceId));
  }

  private publish(workspaceId: string, message: ServerMessage) {
    this.hub.publishWhere((socket) => socket.data.terminalWorkspaceId === workspaceId, message);
  }
}
