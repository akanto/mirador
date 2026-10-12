import { expect, test } from "bun:test";
import { Hub, socketData, type BrowserSocket, type SocketData } from "../host/hub.ts";
import type { Conversation } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { countWaiting } from "../shared/waiting.ts";
import { tabTitle } from "../web/tab-title.ts";

const c = (waitingFor: Conversation["waitingFor"]) => ({ waitingFor }) as Conversation;

test("counts every conversation waiting for you, whatever it waits for", () => {
  expect(countWaiting([c("permission"), c("question"), c("finished"), c("error"), c(null)])).toBe(4);
  expect(countWaiting([])).toBe(0);
  expect(countWaiting([c(null)])).toBe(0);
});

test("the tab title carries the count only while something waits", () => {
  expect(tabTitle(0)).toBe("Mirador");
  expect(tabTitle(2)).toBe("(2) Mirador");
});

function connect(hub: Hub, role: SocketData["role"]) {
  const received: ServerMessage[] = [];
  const socket = { data: socketData(role, null), send: (payload: string) => received.push(JSON.parse(payload)) } as unknown as BrowserSocket;
  hub.add(socket);
  return received;
}

test("only the desktop app hears the count", () => {
  const hub = new Hub();
  const page = connect(hub, "page");
  const notifier = connect(hub, "notifier");
  hub.announceWaitingCount(3);
  expect(notifier).toEqual([{ type: "waiting.counted", count: 3 }]);
  expect(page).toEqual([]);
});

test("the desktop app hears the count only when it changed", () => {
  const hub = new Hub();
  const notifier = connect(hub, "notifier");
  [0, 2, 2, 2, 1, 1, 0].forEach((count) => hub.announceWaitingCount(count));
  expect(notifier.map((message) => message.type === "waiting.counted" && message.count)).toEqual([0, 2, 1, 0]);
});

test("only the desktop app hears the running turns count, and only when it changed", () => {
  const hub = new Hub();
  const page = connect(hub, "page");
  const notifier = connect(hub, "notifier");
  hub.announceRunningTurnsCount(2);
  hub.announceRunningTurnsCount(2);
  hub.announceRunningTurnsCount(0);
  expect(notifier).toEqual([
    { type: "running-turns.counted", count: 2 },
    { type: "running-turns.counted", count: 0 },
  ]);
  expect(page).toEqual([]);
});
