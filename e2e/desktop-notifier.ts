import { HostNotifications, openWebSocket } from "../desktop/src/core/host-notifications.ts";

/** Listens to a test host the way the desktop app does, printing a line when connected and one per notification it would show. */
const [origin, token] = process.argv.slice(2) as [string, string];

new HostNotifications({
  origin,
  token: () => token,
  show: (notification) => console.log(JSON.stringify(notification)),
  open: (url, headers) => {
    const socket = openWebSocket(url, headers) as WebSocket;
    socket.addEventListener("open", () => console.log("connected"));
    return socket;
  },
}).start();
