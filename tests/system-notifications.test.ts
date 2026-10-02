import { describe, expect, test } from "bun:test";
import { Hub, socketData, type BrowserSocket, type SocketData } from "../host/hub.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { bodyWithWorkspace, systemNotification, turnEndReason, type SystemNotification } from "../shared/system-notifications.ts";

const conversation = { id: "c1", title: "Fix the tray menu" };

describe("system notification text", () => {
  test("names the conversation and its workspace, and says why", () => {
    expect(systemNotification(conversation, "mirador", { kind: "question", question: "Which layout?" })).toEqual({
      conversationId: "c1",
      title: "Fix the tray menu",
      workspace: "mirador",
      body: "Asks: Which layout?",
    });
    expect(systemNotification(conversation, "mirador", { kind: "permission", tool: "bun run test" }).body).toBe("Wants permission: bun run test");
    expect(systemNotification(conversation, "mirador", { kind: "permission", tool: null }).body).toBe("Wants permission: a tool");
    expect(systemNotification(conversation, "mirador", { kind: "finished" }).body).toBe("Finished, waiting for you");
    expect(systemNotification(conversation, "mirador", { kind: "error", message: "exited" }).body).toBe("Stopped with an error: exited");
  });

  test("keeps the body to one short line", () => {
    const body = systemNotification(conversation, "mirador", { kind: "question", question: `Line one\n\n  line two ${"x".repeat(300)}` }).body;
    expect(body.startsWith("Asks: Line one line two x")).toBe(true);
    expect(body).toHaveLength(200);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("a turn that ends makes it your move", () => {
  test("when it finished or stopped with an error", () => {
    expect(turnEndReason({ stopReason: "end_turn" }, false)).toEqual({ kind: "finished" });
    expect(turnEndReason({ error: "boom" }, false)).toEqual({ kind: "error", message: "boom" });
  });

  test("but not when you cancelled it, nor when a queued message goes out next", () => {
    expect(turnEndReason({ stopReason: "cancelled" }, false)).toBeNull();
    expect(turnEndReason({ stopReason: "end_turn" }, true)).toBeNull();
    expect(turnEndReason({ error: "boom" }, true)).toBeNull();
  });
});

describe("delivery", () => {
  function connect(hub: Hub, role: SocketData["role"]) {
    const received: ServerMessage[] = [];
    const socket = { data: socketData(role), send: (payload: string) => received.push(JSON.parse(payload)) } as unknown as BrowserSocket;
    hub.add(socket);
    return { socket, received };
  }
  const notification: SystemNotification = { conversationId: "c1", title: "t", workspace: "w", body: "Finished, waiting for you" };
  const notificationsIn = (received: ServerMessage[]) => received.filter(({ type }) => type === "system-notification");

  test("goes to every open page while the desktop app is not listening", () => {
    const hub = new Hub();
    const [first, second] = [connect(hub, "page"), connect(hub, "page")];
    hub.notify(notification);
    expect(notificationsIn(first.received)).toEqual([{ type: "system-notification", notification }]);
    expect(notificationsIn(second.received)).toHaveLength(1);
  });

  test("goes only to the desktop app while it listens, which hears nothing else", () => {
    const hub = new Hub();
    const page = connect(hub, "page");
    const desktop = connect(hub, "notifier");
    hub.notify(notification);
    hub.broadcast({ type: "workspace.deleted", workspaceId: "w1" });
    expect(notificationsIn(page.received)).toEqual([]);
    expect(desktop.received).toEqual([{ type: "system-notification", notification }]);

    hub.remove(desktop.socket);
    hub.notify(notification);
    expect(notificationsIn(page.received)).toHaveLength(1);
  });

  test("a conversation counts as watched only while a focused page shows it", () => {
    const hub = new Hub();
    const page = connect(hub, "page");
    expect(hub.isWatched("c1")).toBe(false);
    page.socket.data.presence = { conversationId: "c1", attentive: false };
    expect(hub.isWatched("c1")).toBe(false);
    page.socket.data.presence = { conversationId: "c1", attentive: true };
    expect(hub.isWatched("c1")).toBe(true);
    expect(hub.isWatched("c2")).toBe(false);
  });
});

test("without a subtitle line the workspace leads the body", () => {
  const notification = systemNotification(conversation, "mirador", { kind: "finished" });
  expect(bodyWithWorkspace(notification)).toBe("mirador · Finished, waiting for you");
  expect(bodyWithWorkspace({ ...notification, workspace: "" })).toBe("Finished, waiting for you");
});
