import type { ServerWebSocket } from "bun";
import type { ServerMessage } from "../shared/protocol.ts";

export interface SocketData {
  subscriptions: Set<string>;
  terminalWorkspaceId: string | null;
}

export type BrowserSocket = ServerWebSocket<SocketData>;

export class Hub {
  private readonly sockets = new Set<BrowserSocket>();

  add(socket: BrowserSocket) {
    this.sockets.add(socket);
  }

  remove(socket: BrowserSocket) {
    this.sockets.delete(socket);
  }

  send(socket: BrowserSocket, message: ServerMessage) {
    socket.send(JSON.stringify(message));
  }

  broadcast(message: ServerMessage) {
    const payload = JSON.stringify(message);
    this.sockets.forEach((socket) => socket.send(payload));
  }

  hasSubscribers(conversationId: string) {
    return [...this.sockets].some((socket) => socket.data.subscriptions.has(conversationId));
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
