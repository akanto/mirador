import type { Subprocess } from "bun";
import type { ServerMessage } from "../shared/protocol.ts";
import { agentEnvironment, loginShell } from "./acp/environment.ts";
import type { BrowserSocket, Hub } from "./hub.ts";

const SCROLLBACK_CHARACTERS = 256 * 1024;
const MAX_DIMENSION = 1_000;

interface Shell {
  id: string;
  workspaceId: string;
  child: Subprocess;
  scrollback: string[];
  scrollbackLength: number;
}

const dimension = (value: number) => Math.min(Math.max(1, Math.floor(value) || 1), MAX_DIMENSION);

/**
 * Login shells on pseudo-terminals, started in a workspace's folder. They live in the host, so reloading
 * the page reattaches to them (the recent output is replayed), and they end when the host stops.
 * Their output is only ever sent to browsers, never logged or stored.
 */
export class TerminalService {
  private readonly shells = new Map<string, Shell>();

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

  open(workspaceId: string, columns: number, rows: number) {
    const cwd = this.workspacePath(workspaceId);
    if (!cwd) throw new Error("This workspace no longer exists.");
    const decoder = new TextDecoder();
    const shell: Shell = { id: crypto.randomUUID(), workspaceId, child: undefined!, scrollback: [], scrollbackLength: 0 };
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
    this.publishListing(workspaceId);
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

  closeWorkspace(workspaceId: string) {
    this.shellsIn(workspaceId).forEach(({ id }) => this.close(id));
  }

  shutdown() {
    this.shells.forEach(({ id }) => this.close(id));
  }

  private received(shell: Shell, text: string) {
    if (!text) return;
    shell.scrollback.push(text);
    shell.scrollbackLength += text.length;
    while (shell.scrollbackLength > SCROLLBACK_CHARACTERS && shell.scrollback.length > 1) {
      shell.scrollbackLength -= shell.scrollback.shift()!.length;
    }
    this.publish(shell.workspaceId, { type: "terminal.output", terminalId: shell.id, data: text });
  }

  private ended(shell: Shell, exitCode: number) {
    shell.child.terminal?.close();
    this.shells.delete(shell.id);
    this.publish(shell.workspaceId, { type: "terminal.exited", terminalId: shell.id, exitCode });
    this.publishListing(shell.workspaceId);
  }

  private shellsIn(workspaceId: string) {
    return [...this.shells.values()].filter((shell) => shell.workspaceId === workspaceId);
  }

  private listing(workspaceId: string): ServerMessage {
    return { type: "terminals.listed", workspaceId, terminalIds: this.shellsIn(workspaceId).map(({ id }) => id) };
  }

  private publishListing(workspaceId: string) {
    this.publish(workspaceId, this.listing(workspaceId));
  }

  private publish(workspaceId: string, message: ServerMessage) {
    this.hub.publishWhere((socket) => socket.data.terminalWorkspaceId === workspaceId, message);
  }
}
