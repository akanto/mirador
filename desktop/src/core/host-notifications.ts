import { TOKEN_COOKIE, type ServerMessage } from "../../../shared/protocol.ts";
import { bodyWithWorkspace, type SystemNotification } from "../../../shared/system-notifications.ts";

const RETRY_DELAY_MILLISECONDS = 2_000;

export interface NativeNotification {
  title: string;
  subtitle?: string;
  body: string;
}

/** macOS has a subtitle line for the workspace; notify-send on Linux does not. */
export const nativeNotification = (notification: SystemNotification, platform: NodeJS.Platform): NativeNotification =>
  platform === "darwin"
    ? { title: notification.title, subtitle: notification.workspace, body: notification.body }
    : { title: notification.title, body: bodyWithWorkspace(notification) };

export const notificationSocketUrl = (origin: string) => `${origin.replace(/^http/, "ws")}/notifications`;

export interface NotificationSocket {
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(): void;
}

export type SocketOpener = (url: string, headers: Record<string, string>) => NotificationSocket;

/** With the DOM library loaded, TypeScript hides the overload of Bun's WebSocket that takes headers. */
type BunWebSocket = new (url: string, options: Bun.WebSocketOptions) => WebSocket;

export const openWebSocket: SocketOpener = (url, headers) => new (WebSocket as unknown as BunWebSocket)(url, { headers });

export interface HostNotificationsOptions {
  origin: string;
  /** Read again for every connection: the host writes it on its first start, which may come after the app's. */
  token: () => string | null;
  show: (notification: SystemNotification) => void;
  open?: SocketOpener;
  retryDelayMilliseconds?: number;
}

/** Listens to the host for system notifications, connecting again whenever the host restarts or is not up yet. */
export class HostNotifications {
  private socket?: NotificationSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly options: HostNotificationsOptions) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
  }

  private connect() {
    const { origin, token, show, open = openWebSocket } = this.options;
    const currentToken = token();
    if (!currentToken) return this.connectLater();
    const socket = open(notificationSocketUrl(origin), { Origin: origin, Cookie: `${TOKEN_COOKIE}=${currentToken}` });
    this.socket = socket;
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === "system-notification") show(message.notification);
    };
    socket.onclose = () => this.connectLater();
  }

  private connectLater() {
    if (this.stopped) return;
    this.retry = setTimeout(() => this.connect(), this.options.retryDelayMilliseconds ?? RETRY_DELAY_MILLISECONDS);
  }
}
