import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TERMINALS_PER_TAB, type TerminalTab } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { Hub, type BrowserSocket } from "../host/hub.ts";
import { TerminalService } from "../host/terminals.ts";

let workspaceDir: string;
let terminals: TerminalService;
let hub: Hub;
const originalShell = process.env.SHELL;
const originalHome = process.env.HOME;

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

const lastTabs = (received: ServerMessage[]): TerminalTab[] | undefined =>
  received.findLast((message) => message.type === "terminals.listed")?.tabs;

async function eventually<T>(read: () => T, isDone: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (!isDone(read()) && Date.now() < deadline) await Bun.sleep(20);
  return read();
}

const outputContaining = (received: ServerMessage[], text: string) =>
  eventually(() => outputOf(received), (output) => output.includes(text));

const tabsOnceSettled = (received: ServerMessage[], isSettled: (tabs: TerminalTab[]) => boolean) =>
  eventually(() => lastTabs(received) ?? [], isSettled);

beforeEach(async () => {
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "mirador-terminals-")));
  process.env.SHELL = "/bin/sh";
  process.env.HOME = workspaceDir;
  hub = new Hub();
  terminals = new TerminalService(hub, (workspaceId) => (workspaceId === "w1" ? workspaceDir : undefined));
});

afterEach(async () => {
  terminals.shutdown();
  process.env.SHELL = originalShell;
  process.env.HOME = originalHome;
  await rm(workspaceDir, { recursive: true, force: true });
});

test("a terminal runs a shell in the workspace folder, sized as asked, and streams to browsers attached to that workspace", async () => {
  const watching = fakeBrowser();
  const elsewhere = fakeBrowser();
  terminals.attach(watching.socket, "w1");
  terminals.attach(elsewhere.socket, "w2");
  const { terminalId } = terminals.open("w1", 100, 30);

  terminals.input(terminalId, "pwd; stty size\n");
  expect(await outputContaining(watching.received, "30 100")).toContain(`${workspaceDir}\r\n30 100`);
  terminals.resize(terminalId, 120, 40);
  terminals.input(terminalId, "stty size\n");
  expect(await outputContaining(watching.received, "40 120")).toContain("40 120");
  expect(elsewhere.received.filter(({ type }) => type.startsWith("terminal"))).toEqual([{ type: "terminals.listed", workspaceId: "w2", tabs: [] }]);
});

test("a browser that attaches later gets the tabs and can replay what each terminal printed", async () => {
  const first = fakeBrowser();
  terminals.attach(first.socket, "w1");
  const { tabId, terminalId } = terminals.open("w1", 100, 30);
  terminals.input(terminalId, "echo before-reload\n");
  expect(await outputContaining(first.received, "before-reload\r\n")).toContain("before-reload\r\n");

  const reloaded = fakeBrowser();
  terminals.attach(reloaded.socket, "w1");
  terminals.replay(reloaded.socket, terminalId);
  expect(lastTabs(reloaded.received)).toEqual([{ id: tabId, name: "sh", terminals: [{ id: terminalId, title: null }] }]);
  const replayed = reloaded.received.find((message) => message.type === "terminal.replayed");
  expect(replayed).toMatchObject({ terminalId, data: expect.stringContaining("before-reload\r\n") });
});

test("clearing a terminal forgets the output above the cursor's line, in every window and in what a reload replays", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const { terminalId } = terminals.open("w1", 100, 30);
  terminals.input(terminalId, "echo above-the-cursor; printf on-the-cursor-line\n");
  await outputContaining(browser.received, "above-the-cursor\r\non-the-cursor-line");

  terminals.clear(terminalId);
  expect(browser.received.at(-1)).toEqual({ type: "terminal.cleared", terminalId });
  terminals.replay(browser.socket, terminalId);
  const replayed = browser.received.findLast((message) => message.type === "terminal.replayed");
  expect(replayed).toMatchObject({ data: expect.stringContaining("on-the-cursor-line") });
  expect(replayed).not.toMatchObject({ data: expect.stringContaining("above-the-cursor") });
});

test("new tabs are named after the shell with the lowest free number, and a tab splits into at most four terminals", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const first = terminals.open("w1", 80, 24);
  const second = terminals.open("w1", 80, 24);
  const splits = Array.from({ length: MAX_TERMINALS_PER_TAB - 1 }, () => terminals.open("w1", 80, 24, first.tabId));

  expect(splits.every(({ tabId }) => tabId === first.tabId)).toBe(true);
  expect(lastTabs(browser.received)?.map(({ name, terminals }) => [name, terminals.length])).toEqual([
    ["sh", MAX_TERMINALS_PER_TAB],
    ["sh 2", 1],
  ]);
  expect(() => terminals.open("w1", 80, 24, first.tabId)).toThrow(`A tab holds at most ${MAX_TERMINALS_PER_TAB} terminals.`);

  terminals.closeTab(second.tabId);
  expect((await tabsOnceSettled(browser.received, (tabs) => tabs.length === 1)).map(({ name }) => name)).toEqual(["sh"]);
  expect(() => terminals.open("w1", 80, 24, second.tabId)).toThrow("That terminal tab is closed.");
  terminals.open("w1", 80, 24);
  expect(lastTabs(browser.received)?.map(({ name }) => name)).toEqual(["sh", "sh 2"]);
});

test("a terminal that exits leaves its tab, and the tab goes with its last terminal", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const kept = terminals.open("w1", 80, 24);
  const exiting = terminals.open("w1", 80, 24, kept.tabId);
  terminals.input(exiting.terminalId, "exit 3\n");
  const exited = await eventually(() => browser.received.find((message) => message.type === "terminal.exited"), (message) => message !== undefined);
  expect(exited).toEqual({ type: "terminal.exited", terminalId: exiting.terminalId, exitCode: 3 });
  expect(lastTabs(browser.received)).toMatchObject([{ id: kept.tabId, terminals: [{ id: kept.terminalId }] }]);

  terminals.close(kept.terminalId);
  expect(await tabsOnceSettled(browser.received, (tabs) => tabs.length === 0)).toEqual([]);
});

test("each terminal in a tab carries the title its shell sets", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const { tabId, terminalId } = terminals.open("w1", 80, 24);
  const split = terminals.open("w1", 80, 24, tabId);
  terminals.input(split.terminalId, "printf '\\033]0;my-title\\007'\n");
  const [tab] = await tabsOnceSettled(browser.received, ([only]) => only?.terminals[1]?.title === "my-title");
  expect(tab?.terminals).toEqual([
    { id: terminalId, title: null },
    { id: split.terminalId, title: "my-title" },
  ]);
});

test("opening a terminal in a workspace that no longer exists fails", () => {
  expect(() => terminals.open("gone", 80, 24)).toThrow("This workspace no longer exists.");
});
