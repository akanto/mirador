import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TERMINALS_PER_TAB, type Conversation, type TerminalTab } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { Hub, type BrowserSocket } from "../host/hub.ts";
import { Store } from "../host/store.ts";
import { RESTARTED_NOTE, TerminalService } from "../host/terminals.ts";

let workspaceDir: string;
let store: Store;
let terminals: TerminalService;
let hub: Hub;
const TEST_SAVE_DELAY_MS = 50;
const originalShell = process.env.SHELL;
const originalHome = process.env.HOME;

function fakeBrowser() {
  const received: ServerMessage[] = [];
  const socket = {
    data: { subscriptions: new Set<string>(), terminalConversationId: null },
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

/** A negative pid asks after a whole process group. */
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const beside = (terminalId: string) => ({ terminalId, axis: "columns" as const });
const below = (terminalId: string) => ({ terminalId, axis: "rows" as const });

const tabsOnceSettled = (received: ServerMessage[], isSettled: (tabs: TerminalTab[]) => boolean) =>
  eventually(() => lastTabs(received) ?? [], isSettled);

const conversationInWorkspace = (id: string): Omit<Conversation, "position"> => ({
  id,
  workspaceId: "w1",
  harness: "claude",
  profileId: null,
  title: id,
  titleSetByUser: false,
  acpSessionId: null,
  askMode: "wait",
  bypassPermissions: false,
  status: "idle",
  statusDetail: null,
  openInTerminal: null,
  contextUsage: null,
  queuedMessages: [],
  usageLimit: null,
  jobWaits: [],
  waitingFor: null,
  pendingRequest: null,
  lastWords: null,
  activity: null,
  configOptions: [],
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(async () => {
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "mirador-terminals-")));
  process.env.SHELL = "/bin/sh";
  process.env.HOME = workspaceDir;
  store = new Store(":memory:");
  store.insertWorkspace({ id: "w1", name: "project", path: workspaceDir, defaultLaunch: { harness: "claude", profileId: null }, createdAt: 1 });
  ["c1", "c2"].forEach((id) => store.insertConversation(conversationInWorkspace(id)));
  hub = new Hub();
  terminals = new TerminalService(hub, store, TEST_SAVE_DELAY_MS);
});

/** Stops the host's terminals and starts the next run's on the same store, as a restart does. */
async function restartHost() {
  await terminals.shutdown();
  terminals = new TerminalService(hub, store, TEST_SAVE_DELAY_MS);
}

const replayed = (received: ServerMessage[], terminalId: string) =>
  received.flatMap((message) => (message.type === "terminal.replayed" && message.terminalId === terminalId ? [message.data] : [])).at(-1) ?? "";

const savedOutputOf = (terminalId: string) => store.listTerminalTabs("c1")[0]?.scrollback.get(terminalId) ?? "";

afterEach(async () => {
  await terminals.shutdown();
  process.env.SHELL = originalShell;
  process.env.HOME = originalHome;
  await rm(workspaceDir, { recursive: true, force: true });
});

test("a terminal runs a shell in the workspace folder, sized as asked, and streams to browsers attached to its conversation, not to another of the workspace", async () => {
  const watching = fakeBrowser();
  const elsewhere = fakeBrowser();
  terminals.attach(watching.socket, "c1");
  terminals.attach(elsewhere.socket, "c2");
  const { terminalId } = terminals.open("c1", 100, 30);

  terminals.input(terminalId, "pwd; stty size\n");
  expect(await outputContaining(watching.received, "30 100")).toContain(`${workspaceDir}\r\n30 100`);
  terminals.resize(terminalId, 120, 40);
  terminals.input(terminalId, "stty size\n");
  expect(await outputContaining(watching.received, "40 120")).toContain("40 120");
  expect(elsewhere.received.filter(({ type }) => type.startsWith("terminal"))).toEqual([{ type: "terminals.listed", conversationId: "c2", tabs: [] }]);
});

test("a browser that attaches later gets the tabs and can replay what each terminal printed", async () => {
  const first = fakeBrowser();
  terminals.attach(first.socket, "c1");
  const { tabId, terminalId } = terminals.open("c1", 100, 30);
  terminals.input(terminalId, "echo before-reload\n");
  expect(await outputContaining(first.received, "before-reload\r\n")).toContain("before-reload\r\n");

  const reloaded = fakeBrowser();
  terminals.attach(reloaded.socket, "c1");
  terminals.replay(reloaded.socket, terminalId);
  expect(lastTabs(reloaded.received)).toEqual([{ id: tabId, name: "sh", terminals: [{ id: terminalId, title: null }], layout: { terminalId } }]);
  const replayed = reloaded.received.find((message) => message.type === "terminal.replayed");
  expect(replayed).toMatchObject({ terminalId, data: expect.stringContaining("before-reload\r\n") });
});

test("clearing a terminal forgets the output above the cursor's line, in every window and in what a reload replays", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const { terminalId } = terminals.open("c1", 100, 30);
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
  terminals.attach(browser.socket, "c1");
  const first = terminals.open("c1", 80, 24);
  const second = terminals.open("c1", 80, 24);
  const splits = Array.from({ length: MAX_TERMINALS_PER_TAB - 1 }, () => terminals.open("c1", 80, 24, beside(first.terminalId)));

  expect(splits.every(({ tabId }) => tabId === first.tabId)).toBe(true);
  expect(lastTabs(browser.received)?.map(({ name, terminals }) => [name, terminals.length])).toEqual([
    ["sh", MAX_TERMINALS_PER_TAB],
    ["sh 2", 1],
  ]);
  expect(() => terminals.open("c1", 80, 24, beside(first.terminalId))).toThrow(`A tab holds at most ${MAX_TERMINALS_PER_TAB} terminals.`);

  terminals.closeTab(second.tabId);
  expect((await tabsOnceSettled(browser.received, (tabs) => tabs.length === 1)).map(({ name }) => name)).toEqual(["sh"]);
  expect(() => terminals.open("c1", 80, 24, beside(second.terminalId))).toThrow("That terminal is closed.");
  terminals.open("c1", 80, 24);
  expect(lastTabs(browser.received)?.map(({ name }) => name)).toEqual(["sh", "sh 2"]);
});

test.if(process.platform === "win32")("on Windows a new tab runs PowerShell in the workspace folder, and is named after it", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const { terminalId } = terminals.open("c1", 100, 30);

  terminals.input(terminalId, "Write-Output \"in $((Get-Location).Path) with $($PSVersionTable.PSEdition)\"\r");
  expect(await outputContaining(browser.received, `in ${workspaceDir} with`)).toMatch(/with (Desktop|Core)/);
  expect(lastTabs(browser.received)?.map(({ name }) => name)).toEqual([expect.stringMatching(/^(powershell|pwsh)$/)]);
});

test.if(process.platform === "win32")("on Windows closing unless busy closes a terminal at its prompt, keeps one running a program, naming it, and closing that ends the program too", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const idle = terminals.open("c1", 80, 24);
  const working = terminals.open("c1", 80, 24, beside(idle.terminalId));
  terminals.input(working.terminalId, `& '${process.execPath}' -e "console.log('started-' + process.pid); setTimeout(() => {}, 30000)"\r`);
  const program = Number(await eventually(() => outputOf(browser.received).match(/started-(\d+)/)?.[1], (pid) => pid !== undefined));

  await terminals.closeUnlessBusy(browser.socket, working.terminalId);
  expect(browser.received.findLast((message) => message.type === "terminal.busy")).toEqual({ type: "terminal.busy", terminalId: working.terminalId, command: "bun" });
  await terminals.closeUnlessBusy(browser.socket, idle.terminalId);
  const [left] = await tabsOnceSettled(browser.received, ([only]) => only?.terminals.length === 1);
  expect(left?.terminals.map(({ id }) => id)).toEqual([working.terminalId]);

  expect(isRunning(program)).toBe(true);
  terminals.close(working.terminalId);
  expect(await eventually(() => isRunning(program), (running) => !running)).toBe(false);
}, 20_000);

test.if(process.platform === "win32")("on Windows closing a terminal ends what its shell started outside the terminal too", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const { terminalId } = terminals.open("c1", 80, 24);
  const detached = `Start-Process -PassThru -WindowStyle Hidden -FilePath '${process.execPath}' -ArgumentList '-e', '"setTimeout(() => {}, 30000)"'`;
  terminals.input(terminalId, `Write-Output "started-$((${detached}).Id)"\r`);
  const program = Number(await eventually(() => outputOf(browser.received).match(/started-(\d+)/)?.[1], (pid) => pid !== undefined));

  expect(isRunning(program)).toBe(true);
  terminals.close(terminalId);
  expect(await eventually(() => isRunning(program), (running) => !running)).toBe(false);
}, 20_000);

test("a terminal that exits leaves its tab, and the tab goes with its last terminal", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const kept = terminals.open("c1", 80, 24);
  const exiting = terminals.open("c1", 80, 24, beside(kept.terminalId));
  terminals.input(exiting.terminalId, "exit 3\n");
  const exited = await eventually(() => browser.received.find((message) => message.type === "terminal.exited"), (message) => message !== undefined);
  expect(exited).toEqual({ type: "terminal.exited", terminalId: exiting.terminalId, exitCode: 3 });
  expect(lastTabs(browser.received)).toMatchObject([{ id: kept.tabId, terminals: [{ id: kept.terminalId }] }]);

  terminals.close(kept.terminalId);
  expect(await tabsOnceSettled(browser.received, (tabs) => tabs.length === 0)).toEqual([]);
});

test("each terminal in a tab carries the title its shell sets", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const { tabId, terminalId } = terminals.open("c1", 80, 24);
  const split = terminals.open("c1", 80, 24, beside(terminalId));
  terminals.input(split.terminalId, "printf '\\033]0;my-title\\007'\n");
  const [tab] = await tabsOnceSettled(browser.received, ([only]) => only?.terminals[1]?.title === "my-title");
  expect(tab?.terminals).toEqual([
    { id: terminalId, title: null },
    { id: split.terminalId, title: "my-title" },
  ]);
});

test("a runaway title is cut to 200 characters", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const { terminalId } = terminals.open("c1", 80, 24);
  terminals.input(terminalId, "printf '\\033]0;%s\\007' \"$(printf 'x%.0s' $(seq 1 500))\"\n");
  const [tab] = await tabsOnceSettled(browser.received, ([only]) => (only?.terminals[0]?.title?.length ?? 0) > 0);
  expect(tab?.terminals[0]?.title).toBe("x".repeat(200));
});

test("a terminal splits beside or below itself, and the others close up when one exits", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const left = terminals.open("c1", 80, 24);
  const right = terminals.open("c1", 80, 24, beside(left.terminalId));
  const belowRight = terminals.open("c1", 80, 24, below(right.terminalId));
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
  terminals.attach(browser.socket, "c1");
  const idle = terminals.open("c1", 80, 24);
  const working = terminals.open("c1", 80, 24, beside(idle.terminalId));
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
  terminals.attach(browser.socket, "c1");
  const idle = terminals.open("c1", 80, 24);
  const working = terminals.open("c1", 80, 24);
  const split = terminals.open("c1", 80, 24, beside(working.terminalId));
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
  terminals.attach(browser.socket, "c1");
  const follow = { tabName: "follow", key: "follow job", command: ["sh", "-c", "read line"] };
  const first = terminals.openProgram("c1", 80, 24, follow);
  const again = terminals.openProgram("c1", 80, 24, follow);
  expect({ tabId: again.tabId, terminalId: again.terminalId }).toEqual({ tabId: first.tabId, terminalId: first.terminalId });
  const unkeyed = terminals.openProgram("c1", 80, 24, { tabName: "follow", command: ["sh", "-c", "read line"] });
  expect(lastTabs(browser.received)?.map(({ id }) => id)).toEqual([first.tabId, unkeyed.tabId]);

  terminals.input(first.terminalId, "\n");
  await first.exited;
  const afterEnding = terminals.openProgram("c1", 80, 24, follow);
  expect(afterEnding.terminalId).not.toBe(first.terminalId);
});

test("shutting down waits for every shell to exit, so a host that re-executes itself leaves no zombie behind", async () => {
  const watching = fakeBrowser();
  terminals.attach(watching.socket, "c1");
  [terminals.open("c1", 80, 24), terminals.open("c1", 80, 24)].forEach(({ terminalId }) => terminals.input(terminalId, "echo shell-$$-up\n"));
  const shellsUp = () => new Set(outputOf(watching.received).match(/shell-\d+-up/g));
  const pids = [...(await eventually(shellsUp, (up) => up.size === 2))].map((up) => Number(up.split("-")[1]));

  await terminals.shutdown();

  expect(pids.filter(isRunning)).toEqual([]);
});

test("two conversations of a workspace have tabs of their own, and closing one conversation's terminals leaves the other's running", async () => {
  const first = fakeBrowser();
  const second = fakeBrowser();
  terminals.attach(first.socket, "c1");
  terminals.attach(second.socket, "c2");
  const ofFirst = terminals.open("c1", 80, 24);
  const ofSecond = terminals.open("c2", 80, 24);
  expect(lastTabs(first.received)?.map(({ id }) => id)).toEqual([ofFirst.tabId]);
  expect(lastTabs(second.received)?.map(({ id }) => id)).toEqual([ofSecond.tabId]);

  terminals.closeConversation("c1");
  expect(await tabsOnceSettled(first.received, (tabs) => tabs.length === 0)).toEqual([]);
  terminals.input(ofSecond.terminalId, "echo still-$((40+2))\n");
  expect(await outputContaining(second.received, "still-42")).toContain("still-42");
  expect(lastTabs(second.received)?.map(({ id }) => id)).toEqual([ofSecond.tabId]);
});

test("after a restart, a conversation's tabs and splits come back with new shells, under what the old shells showed", async () => {
  const before = fakeBrowser();
  terminals.attach(before.socket, "c1");
  const first = terminals.open("c1", 80, 24);
  terminals.open("c1", 80, 24, below(first.terminalId));
  const second = terminals.open("c1", 80, 24);
  terminals.input(first.terminalId, "OLD=old-shell; echo before-$((1+1))\n");
  await outputContaining(before.received, "before-2");
  const tabsBefore = lastTabs(before.received)!;

  await restartHost();
  const after = fakeBrowser();
  terminals.attach(after.socket, "c1");
  expect(lastTabs(after.received)).toEqual(tabsBefore.map((tab) => ({ ...tab, terminals: tab.terminals.map(({ id }) => ({ id, title: null })) })));
  expect(lastTabs(after.received)!.map(({ id }) => id)).toEqual([first.tabId, second.tabId]);

  terminals.replay(after.socket, first.terminalId);
  const history = replayed(after.received, first.terminalId);
  expect(history).toContain("before-2");
  expect(history.indexOf(RESTARTED_NOTE)).toBeGreaterThan(history.lastIndexOf("before-2"));
  terminals.input(first.terminalId, "echo after-${OLD:-new-shell}\n");
  expect(await outputContaining(after.received, "after-new-shell")).toContain("after-new-shell");
});

test("a full scrollback kept over a restart loses only its oldest lines to the new shell's output", async () => {
  const before = fakeBrowser();
  terminals.attach(before.socket, "c1");
  const { terminalId } = terminals.open("c1", 80, 24);
  terminals.input(terminalId, "awk 'BEGIN { for (i = 0; i < 4000; i++) printf \"line-%d %080d\\n\", i, 0 }'; echo filled-$((2*3))\n");
  await eventually(() => outputOf(before.received), (output) => output.includes("filled-6"), 20_000);

  await restartHost();
  const after = fakeBrowser();
  terminals.attach(after.socket, "c1");
  terminals.input(terminalId, "echo after-$((5+5))\n");
  await outputContaining(after.received, "after-10");
  terminals.replay(after.socket, terminalId);
  const history = replayed(after.received, terminalId);
  expect(history).toContain("line-3999");
  expect(history).toContain(RESTARTED_NOTE);
  expect(history).toContain("after-10");
}, 30_000);

test("a program's tab, a closed tab and a closed split are not there after a restart", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const kept = terminals.open("c1", 80, 24);
  const closedSplit = terminals.open("c1", 80, 24, beside(kept.terminalId));
  terminals.openProgram("c1", 80, 24, { tabName: "follow", command: ["sh", "-c", "read line"] });
  const closedTab = terminals.open("c1", 80, 24);
  terminals.close(closedSplit.terminalId);
  terminals.closeTab(closedTab.tabId);
  await tabsOnceSettled(browser.received, (tabs) => tabs.length === 2 && tabs[0]!.terminals.length === 1);

  await restartHost();
  const after = fakeBrowser();
  terminals.attach(after.socket, "c1");
  expect(lastTabs(after.received)).toEqual([{ id: kept.tabId, name: "sh", layout: { terminalId: kept.terminalId }, terminals: [{ id: kept.terminalId, title: null }] }]);
});

test("a terminal's output is not saved before the save delay, and is saved when the host stops", async () => {
  terminals = new TerminalService(hub, store, 60_000);
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const { terminalId } = terminals.open("c1", 80, 24);
  terminals.input(terminalId, "echo pending-$((4*4))\n");
  await outputContaining(browser.received, "pending-16");
  expect(savedOutputOf(terminalId)).not.toContain("pending-16");

  await terminals.shutdown();
  expect(savedOutputOf(terminalId)).toContain("pending-16");
});

test("clearing a terminal clears its saved output at once, and deleting the conversation forgets its tabs", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const { terminalId } = terminals.open("c1", 80, 24);
  terminals.input(terminalId, "echo secret-$((3*3))\n");
  const savedOutput = () => store.listTerminalTabs("c1")[0]?.scrollback.get(terminalId) ?? "";
  expect(await eventually(savedOutput, (saved) => saved.includes("secret-9"))).toContain("secret-9");

  terminals.clear(terminalId);
  expect(savedOutput()).not.toContain("secret-9");

  terminals.closeConversation("c1");
  store.deleteConversation("c1");
  expect(store.listTerminalTabs("c1")).toEqual([]);
  expect(await tabsOnceSettled(browser.received, (tabs) => tabs.length === 0)).toEqual([]);
});

test("opening a terminal for a conversation that no longer exists fails", () => {
  expect(() => terminals.open("gone", 80, 24)).toThrow("This conversation no longer exists.");
});

test("closing a program's terminal ends what the program started too", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const program = terminals.openProgram("c1", 80, 24, { tabName: "login", command: ["/bin/sh", "-c", 'sh -c "echo started-\\$\\$; exec sleep 1000"; echo after'] });
  const started = await eventually(() => outputOf(browser.received).match(/started-(\d+)/)?.[1], (pid) => pid !== undefined);
  terminals.close(program.terminalId);
  await program.exited;
  expect(await eventually(() => isRunning(Number(started)), (running) => !running)).toBe(false);
});

test("a program that ignores the hangup is killed after a grace period, with what it started, so its terminal still closes", async () => {
  const browser = fakeBrowser();
  terminals.attach(browser.socket, "c1");
  const command = ["/bin/sh", "-c", "trap '' HUP; echo ignoring-$$; while :; do sleep 1000; done"];
  const program = terminals.openProgram("c1", 80, 24, { tabName: "stubborn", command });
  const group = Number((await eventually(() => outputOf(browser.received).match(/ignoring-(\d+)/)?.[1], (pid) => pid !== undefined))!);
  terminals.close(program.terminalId);
  const ended = await Promise.race([program.exited.then(() => "ended"), Bun.sleep(8_000).then(() => "still running")]);
  expect(ended).toBe("ended");
  expect(await eventually(() => isRunning(-group), (running) => !running)).toBe(false);
}, 15_000);
