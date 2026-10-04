import type { ServerWebSocket } from "bun";
import type { ClientAddress, DeviceConnection } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import type { SystemNotification } from "../shared/system-notifications.ts";

export interface Presence {
  conversationId: string | null;
  attentive: boolean;
}

/** A page is the app open in a browser tab or the desktop window; a notifier is the desktop app, listening for system notifications only. */
export interface SocketData {
  role: "page" | "notifier";
  /** The joined device the socket signed in as; null for the host's own link. */
  deviceId: string | null;
  subscriptions: Set<string>;
  terminalWorkspaceId: string | null;
  presence: Presence;
  /** Where the page loads canvas libraries from, fitting the address it reached the host at. */
  canvasAssetsOrigin: string;
  from: ClientAddress;
}

const thisMachine: ClientAddress = { fromAddress: "127.0.0.1", tailscaleUser: null };

export const socketData = (role: SocketData["role"], deviceId: string | null = null, canvasAssetsOrigin = "", from = thisMachine): SocketData => ({
  role,
  deviceId,
  canvasAssetsOrigin,
  from,
  subscriptions: new Set<string>(),
  terminalWorkspaceId: null,
  presence: { conversationId: null, attentive: false },
});

export type BrowserSocket = ServerWebSocket<SocketData>;

export class Hub {
  private readonly sockets = new Set<BrowserSocket>();
  private readonly notifiers = new Set<BrowserSocket>();

  add(socket: BrowserSocket) {
    (socket.data.role === "notifier" ? this.notifiers : this.sockets).add(socket);
  }

  remove(socket: BrowserSocket) {
    this.sockets.delete(socket);
    this.notifiers.delete(socket);
  }

  send(socket: BrowserSocket, message: ServerMessage) {
    socket.send(JSON.stringify(message));
  }

  broadcast(message: ServerMessage) {
    const payload = JSON.stringify(message);
    this.sockets.forEach((socket) => socket.send(payload));
  }

  /** Pages keep recently opened conversations subscribed, hidden; this is whether one is showing it. */
  isShown(conversationId: string) {
    return [...this.sockets].some(({ data: { presence } }) => presence.conversationId === conversationId);
  }

  isWatched(conversationId: string) {
    return [...this.sockets].some(({ data: { presence } }) => presence.attentive && presence.conversationId === conversationId);
  }

  /**
   * Once on each device, this computer counting as one: through its desktop app, or the host that shows this machine
   * there, while one listens, so its pages don't repeat it; otherwise through each of its open pages.
   */
  notify(notification: SystemNotification) {
    this.notifyEachDevice([...this.sockets, ...this.notifiers], notification);
  }

  /** What this host passes on from its other machines; a device that wants those joins the machine itself. */
  notifyThisComputer(notification: SystemNotification) {
    this.notifyEachDevice([...this.sockets, ...this.notifiers].filter(({ data }) => data.deviceId === null), notification);
  }

  private notifyEachDevice(sockets: BrowserSocket[], notification: SystemNotification) {
    const payload = JSON.stringify({ type: "system-notification", notification } satisfies ServerMessage);
    const isNotifier = ({ data }: BrowserSocket) => data.role === "notifier";
    const listenersOn = (device: BrowserSocket[]) => (device.some(isNotifier) ? device.filter(isNotifier) : device);
    [...Map.groupBy(sockets, ({ data }) => data.deviceId).values()].flatMap(listenersOn).forEach((socket) => socket.send(payload));
  }

  /** Each page gets a message of its own. */
  sendEach(messageFor: (socket: BrowserSocket) => ServerMessage) {
    this.sockets.forEach((socket) => this.send(socket, messageFor(socket)));
  }

  /** Each joined device with a connection open now; the latest one says where it connects from. */
  deviceConnections(): Map<string, DeviceConnection> {
    const ofDevices = [...this.notifiers, ...this.sockets].filter(({ data }) => data.deviceId !== null);
    return new Map(
      [...Map.groupBy(ofDevices, ({ data }) => data.deviceId!)].map(([deviceId, sockets]) => [
        deviceId,
        { ...sockets.at(-1)!.data.from, pages: sockets.filter(({ data }) => data.role === "page").length },
      ]),
    );
  }

  disconnectWhere(isTarget: (socket: BrowserSocket) => boolean, reason: string) {
    [...this.sockets, ...this.notifiers].filter(isTarget).forEach((socket) => socket.close(4401, reason));
  }

  publishWhere(isRecipient: (socket: BrowserSocket) => boolean, message: ServerMessage) {
    const payload = JSON.stringify(message);
    this.sockets.forEach((socket) => {
      if (isRecipient(socket)) socket.send(payload);
    });
  }

  publishToConversation(conversationId: string, message: ServerMessage) {
    const payload = JSON.stringify(message);
    this.sockets.forEach((socket) => {
      if (socket.data.subscriptions.has(conversationId)) socket.send(payload);
    });
  }
}
