import type { DeviceConnection, ListedDevice } from "./model.ts";
import { relativeTimeOf } from "./relative-time.ts";

export const joinedOn = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const pagesOpen = (pages: number) => (pages === 0 ? "in the background" : pages === 1 ? "1 page open" : `${pages} pages open`);

/** "connected now, 2 pages open", or "last seen 3 hours ago". */
export const deviceStatus = ({ connection, lastSeenAt }: ListedDevice) =>
  connection ? `connected now, ${pagesOpen(connection.pages)}` : `last seen ${relativeTimeOf(lastSeenAt)}`;

/** "from 100.101.5.7 (someone@github)" */
export const connectedFrom = ({ fromAddress, tailscaleUser }: DeviceConnection) => `from ${fromAddress}${tailscaleUser ? ` (${tailscaleUser})` : ""}`;

/** The devices connected now, besides the one looking. */
export const otherConnectedDevices = (devices: ListedDevice[], thisDeviceId: string | null) =>
  devices.filter(({ id, connection }) => connection !== null && id !== thisDeviceId);

/** "2 devices connected"; on a joined device, which is connected itself, "1 other device connected". */
export function connectedDevicesLabel(count: number, lookingFromAJoinedDevice: boolean) {
  const devices = count === 1 ? "device" : "devices";
  return lookingFromAJoinedDevice ? `${count} other ${devices} connected` : `${count} ${devices} connected`;
}
