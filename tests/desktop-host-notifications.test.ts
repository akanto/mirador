import { describe, expect, test } from "bun:test";
import { HostNotifications, nativeNotification, notificationSocketUrl, type NotificationSocket } from "../desktop/src/core/host-notifications.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import type { SystemNotification } from "../shared/system-notifications.ts";

const notification: SystemNotification = { conversationId: "c1", title: "Fix the tray menu", workspace: "mirador", body: "Asks: Which layout?" };

class FakeSocket implements NotificationSocket {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  receive(message: ServerMessage) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  hostGoesAway() {
    this.onclose?.(new CloseEvent("close"));
  }

  close() {
    this.closed = true;
  }
}

function listen(token: () => string | null = () => "secret") {
  const sockets: FakeSocket[] = [];
  const shown: SystemNotification[] = [];
  const counts: number[] = [];
  const notifications = new HostNotifications({
    origin: "http://127.0.0.1:4600",
    token,
    show: (shownNotification) => void shown.push(shownNotification),
    showWaitingCount: (count) => void counts.push(count),
    open: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
    retryDelayMilliseconds: 1,
  });
  return { notifications, sockets, shown, counts };
}

describe("host notifications in the desktop app", () => {
  test("connects to the host's notification socket signed in like a page", () => {
    const { notifications, sockets } = listen();
    notifications.start();
    expect(sockets[0]).toMatchObject({ url: "ws://127.0.0.1:4600/notifications", headers: { Origin: "http://127.0.0.1:4600", Cookie: "mirador_token=secret" } });
    notifications.stop();
  });

  test("shows each system notification the host sends, and nothing else", () => {
    const { notifications, sockets, shown } = listen();
    notifications.start();
    sockets[0]!.receive({ type: "workspace.deleted", workspaceId: "w1" });
    sockets[0]!.receive({ type: "system-notification", notification });
    expect(shown).toEqual([notification]);
    notifications.stop();
  });

  test("shows the number of conversations waiting that the host sends", () => {
    const { notifications, sockets, counts } = listen();
    notifications.start();
    sockets[0]!.receive({ type: "waiting.counted", count: 2 });
    expect(counts).toEqual([2]);
    notifications.stop();
  });

  test("forgets the count when the host goes away, and takes the next one on reconnecting", async () => {
    const { notifications, sockets, counts } = listen();
    notifications.start();
    sockets[0]!.receive({ type: "waiting.counted", count: 2 });
    sockets[0]!.hostGoesAway();
    expect(counts).toEqual([2, 0]);
    await Bun.sleep(20);
    expect(sockets).toHaveLength(2);
    sockets[1]!.receive({ type: "waiting.counted", count: 1 });
    expect(counts).toEqual([2, 0, 1]);
    notifications.stop();
  });

  test("connects again after the host restarts, and stops for good when told", async () => {
    const { notifications, sockets } = listen();
    notifications.start();
    sockets[0]!.hostGoesAway();
    await Bun.sleep(20);
    expect(sockets).toHaveLength(2);
    notifications.stop();
    expect(sockets[1]!.closed).toBe(true);
    sockets[1]!.hostGoesAway();
    await Bun.sleep(20);
    expect(sockets).toHaveLength(2);
  });

  test("waits for the host to write its token", async () => {
    let token: string | null = null;
    const { notifications, sockets } = listen(() => token);
    notifications.start();
    await Bun.sleep(20);
    expect(sockets).toHaveLength(0);
    token = "written";
    await Bun.sleep(20);
    expect(sockets[0]?.headers.Cookie).toBe("mirador_token=written");
    notifications.stop();
  });

  test("puts the workspace on macOS's subtitle line, and ahead of the body on Linux", () => {
    expect(nativeNotification(notification, "darwin")).toEqual({ title: "Fix the tray menu", subtitle: "mirador", body: "Asks: Which layout?" });
    expect(nativeNotification(notification, "linux")).toEqual({ title: "Fix the tray menu", body: "mirador · Asks: Which layout?" });
  });

  test("turns the app's origin into its notification socket", () => {
    expect(notificationSocketUrl("http://127.0.0.1:4790")).toBe("ws://127.0.0.1:4790/notifications");
    expect(notificationSocketUrl("https://mac.tail0.ts.net:4600", "65a3d4c7")).toBe("wss://mac.tail0.ts.net:4600/notifications?desktop-app-code=65a3d4c7");
  });
});
