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

const beside = (terminalId: string) => ({ terminalId, axis: "columns" as const });
const below = (terminalId: string) => ({ terminalId, axis: "rows" as const });

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
  expect(lastTabs(reloaded.received)).toEqual([{ id: tabId, name: "sh", terminals: [{ id: terminalId, title: null }], layout: { terminalId } }]);
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
  const splits = Array.from({ length: MAX_TERMINALS_PER_TAB - 1 }, () => terminals.open("w1", 80, 24, beside(first.terminalId)));

  expect(splits.every(({ tabId }) => tabId === first.tabId)).toBe(true);
  expect(lastTabs(browser.received)?.map(({ name, terminals }) => [name, terminals.length])).toEqual([
    ["sh", MAX_TERMINALS_PER_TAB],
    ["sh 2", 1],
  ]);
  expect(() => terminals.open("w1", 80, 24, beside(first.terminalId))).toThrow(`A tab holds at most ${MAX_TERMINALS_PER_TAB} terminals.`);

  terminals.closeTab(second.tabId);
  expect((await tabsOnceSettled(browser.received, (tabs) => tabs.length === 1)).map(({ name }) => name)).toEqual(["sh"]);
  expect(() => terminals.open("w1", 80, 24, beside(second.terminalId))).toThrow("That terminal is closed.");
  terminals.open("w1", 80, 24);
  expect(lastTabs(browser.received)?.map(({ name }) => name)).toEqual(["sh", "sh 2"]);
});

test("a terminal that exits leaves its tab, and the tab goes with its last terminal", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const kept = terminals.open("w1", 80, 24);
  const exiting = terminals.open("w1", 80, 24, beside(kept.terminalId));
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
  const split = terminals.open("w1", 80, 24, beside(terminalId));
  terminals.input(split.terminalId, "printf '\\033]0;my-title\\007'\n");
  const [tab] = await tabsOnceSettled(browser.received, ([only]) => only?.terminals[1]?.title === "my-title");
  expect(tab?.terminals).toEqual([
    { id: terminalId, title: null },
    { id: split.terminalId, title: "my-title" },
  ]);
});

test("a terminal splits beside or below itself, and the others close up when one exits", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const left = terminals.open("w1", 80, 24);
  const right = terminals.open("w1", 80, 24, beside(left.terminalId));
  const belowRight = terminals.open("w1", 80, 24, below(right.terminalId));
  const [tab] = lastTabs(browser.received)!;
  expect(tab?.layout).toEqual({
    axis: "columns",
    children: [{ terminalId: left.terminalId }, { axis: "rows", children: [{ terminalId: right.terminalId }, { terminalId: belowRight.terminalId }] }],
  });
  expect(tab?.terminals.map(({ id }) => id)).toEqual([left.terminalId, right.terminalId, belowRight.terminalId]);

  terminals.close(right.terminalId);
  const [closedUp] = await tabsOnceSettled(browser.received, ([only]) => only?.terminals.length === 2);
  expect(closedUp?.layout).toEqual({ axis: "columns", children: [{ terminalId: left.terminalId }, { terminalId: belowRight.terminalId }] });
});

test("closing unless busy closes a terminal at its prompt, and keeps one running a command, naming it", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const idle = terminals.open("w1", 80, 24);
  const working = terminals.open("w1", 80, 24, beside(idle.terminalId));
  terminals.input(working.terminalId, "echo started; sleep 30\n");
  await outputContaining(browser.received, "started\r\n");
  await Bun.sleep(200);

  await terminals.closeUnlessBusy(browser.socket, working.terminalId);
  expect(browser.received.findLast((message) => message.type === "terminal.busy")).toEqual({ type: "terminal.busy", terminalId: working.terminalId, command: "sleep" });
  await terminals.closeUnlessBusy(browser.socket, idle.terminalId);
  const [left] = await tabsOnceSettled(browser.received, ([only]) => only?.terminals.length === 1);
  expect(left?.terminals.map(({ id }) => id)).toEqual([working.terminalId]);
});

test("closing a tab unless busy closes it when every shell sits at its prompt, and otherwise names what runs and keeps it", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const idle = terminals.open("w1", 80, 24);
  const working = terminals.open("w1", 80, 24);
  const split = terminals.open("w1", 80, 24, beside(working.terminalId));
  terminals.input(split.terminalId, "echo started; sleep 30\n");
  await outputContaining(browser.received, "started\r\n");
  await Bun.sleep(200);

  await terminals.closeTabUnlessBusy(browser.socket, working.tabId);
  expect(browser.received.findLast((message) => message.type === "terminal.busy")).toEqual({
    type: "terminal.busy",
    terminalId: split.terminalId,
    command: "sleep",
    tabId: working.tabId,
  });
  await terminals.closeTabUnlessBusy(browser.socket, idle.tabId);
  const left = await tabsOnceSettled(browser.received, (tabs) => tabs.length === 1);
  expect(left.map(({ id }) => id)).toEqual([working.tabId]);
});

test("a program with a key runs once: opening it again while it runs shows its terminal, and after it ends starts it anew", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "w1");
  const follow = { tabName: "follow", key: "follow job", command: ["sh", "-c", "read line"] };
  const first = terminals.openProgram("w1", 80, 24, follow);
  const again = terminals.openProgram("w1", 80, 24, follow);
  expect({ tabId: again.tabId, terminalId: again.terminalId }).toEqual({ tabId: first.tabId, terminalId: first.terminalId });
  const unkeyed = terminals.openProgram("w1", 80, 24, { tabName: "follow", command: ["sh", "-c", "read line"] });
  expect(lastTabs(browser.received)?.map(({ id }) => id)).toEqual([first.tabId, unkeyed.tabId]);

  terminals.input(first.terminalId, "\n");
  await first.exited;
  const afterEnding = terminals.openProgram("w1", 80, 24, follow);
  expect(afterEnding.terminalId).not.toBe(first.terminalId);
});

test("opening a terminal in a workspace that no longer exists fails", () => {
  expect(() => terminals.open("gone", 80, 24)).toThrow("This workspace no longer exists.");
});
