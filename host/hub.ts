import type { ServerWebSocket } from "bun";
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
}

export const socketData = (role: SocketData["role"], deviceId: string | null = null): SocketData => ({
  role,
  deviceId,
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

  /** Through the desktop app when it listens, so open pages don't repeat it; otherwise through every open page. */
  notify(notification: SystemNotification) {
    const payload = JSON.stringify({ type: "system-notification", notification } satisfies ServerMessage);
    (this.notifiers.size > 0 ? this.notifiers : this.sockets).forEach((socket) => socket.send(payload));
  }

  /** Each page gets a message of its own. */
  sendEach(messageFor: (socket: BrowserSocket) => ServerMessage) {
    this.sockets.forEach((socket) => this.send(socket, messageFor(socket)));
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
