import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

export type ConnectionStatus = "connecting" | "open" | "unauthorized" | "reconnecting";

type MessageListener = (message: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

const MAX_RETRY_DELAY_MS = 10_000;

export class Connection {
  private socket?: WebSocket;
  private retryDelay = 500;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  status: ConnectionStatus = "connecting";

  connect() {
    const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.retryDelay = 500;
      this.setStatus("open");
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.messageListeners.forEach((listener) => listener(message));
    };
    socket.onclose = async () => {
      if (!opened && (await this.isUnauthorized())) return this.setStatus("unauthorized");
      this.setStatus("reconnecting");
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
    };
  }

  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  onMessage(listener: MessageListener) {
    this.messageListeners.add(listener);
    return () => void this.messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener);
    return () => void this.statusListeners.delete(listener);
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.statusListeners.forEach((listener) => listener(status));
  }

  private async isUnauthorized() {
    const probe = await fetch("/ws").catch(() => null);
    return probe?.status === 401;
  }
}

export const connection = new Connection();
