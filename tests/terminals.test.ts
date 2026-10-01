import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../shared/protocol.ts";
import { Hub, type BrowserSocket } from "../host/hub.ts";
import { TerminalService } from "../host/terminals.ts";

let workspaceDir: string;
let terminals: TerminalService;
let hub: Hub;
const originalShell = process.env.SHELL;

function fakeBrowser() {
  const received: ServerMessage[] = [];
  const socket = {
    data: { subscriptions: new Set<string>(), terminalWorkspaceId: null },
    send: (payload: string) => received.push(JSON.parse(payload)),
  } as unknown as BrowserSocket;
  hub.add(socket);
  return { socket, received };
}

const outputOf = (received: ServerMessage[]) =>
  received.flatMap((message) => (message.type === "terminal.output" ? [message.data] : [])).join("");

const lastListing = (received: ServerMessage[]) => received.findLast((message) => message.type === "terminals.listed");

async function eventually<T>(read: () => T, isDone: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (!isDone(read()) && Date.now() < deadline) await Bun.sleep(20);
  return read();
}

const outputContaining = (received: ServerMessage[], text: string) =>
  eventually(() => outputOf(received), (output) => output.includes(text));

async function openedTerminal(browser: ReturnType<typeof fakeBrowser>) {
  const before = browser.received.length;
  terminals.open("w1", 100, 30);
  const listing = await eventually(
    () => browser.received.slice(before).findLast((message) => message.type === "terminals.listed"),
    (message) => message !== undefined,
  );
  return listing?.type === "terminals.listed" ? listing.terminalIds.at(-1)! : "";
}

beforeEach(async () => {
  process.env.SHELL = "/bin/sh";
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "mirador-terminals-")));
  hub = new Hub();
  terminals = new TerminalService(hub, (workspaceId) => (workspaceId === "w1" ? workspaceDir : undefined));
});

afterEach(async () => {
  terminals.shutdown();
  process.env.SHELL = originalShell;
  await rm(workspaceDir, { recursive: true, force: true });
});

test("a terminal runs a shell in the workspace folder, sized as asked, and streams to browsers attached to that workspace", async () => {
  const watching = fakeBrowser();
  const elsewhere = fakeBrowser();
  terminals.attach(watching.socket, "w1");
  terminals.attach(elsewhere.socket, "w2");
  const terminalId = await openedTerminal(watching);

  terminals.input(terminalId, "pwd; stty size\n");
  expect(await outputContaining(watching.received, "30 100")).toContain(`${workspaceDir}\r\n30 100`);
  terminals.resize(terminalId, 120, 40);
  terminals.input(terminalId, "stty size\n");
  expect(await outputContaining(watching.received, "40 120")).toContain("40 120");
  expect(elsewhere.received.filter(({ type }) => type.startsWith("terminal"))).toEqual([{ type: "terminals.listed", workspaceId: "w2", terminalIds: [] }]);
});

test("a browser that attaches later gets the list and can replay what the terminal printed", async () => {
  const first = fakeBrowser();
  terminals.attach(first.socket, "w1");
  const terminalId = await openedTerminal(first);
  terminals.input(terminalId, "echo before-reload\n");
  expect(await outputContaining(first.received, "before-reload\r\n")).toContain("before-reload\r\n");

  const reloaded = fakeBrowser();
  terminals.attach(reloaded.socket, "w1");
  terminals.replay(reloaded.socket, terminalId);
  expect(lastListing(reloaded.received)).toEqual({ type: "terminals.listed", workspaceId: "w1", terminalIds: [terminalId] });
  const replayed = reloaded.received.find((message) => message.type === "terminal.replayed");
  expect(replayed).toMatchObject({ terminalId, data: expect.stringContaining("before-reload\r\n") });
});

test("exiting the shell or closing the terminal ends it and takes it off the list", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const exiting = await openedTerminal(browser);
  terminals.input(exiting, "exit 3\n");
  const exited = await eventually(() => browser.received.find((message) => message.type === "terminal.exited"), (message) => message !== undefined);
  expect(exited).toEqual({ type: "terminal.exited", terminalId: exiting, exitCode: 3 });
  expect(lastListing(browser.received)).toMatchObject({ terminalIds: [] });

  const closing = await openedTerminal(browser);
  terminals.close(closing);
  const afterClose = await eventually(() => lastListing(browser.received), (message) => message?.type === "terminals.listed" && message.terminalIds.length === 0);
  expect(afterClose).toMatchObject({ terminalIds: [] });
});

test("opening a terminal in a workspace that no longer exists fails", () => {
  expect(() => terminals.open("gone", 80, 24)).toThrow("This workspace no longer exists.");
});
