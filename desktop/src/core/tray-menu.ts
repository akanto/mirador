import { newerVersionLabel, type NewerVersion } from "../../../shared/newer-version.ts";
import { MIRADOR_VERSION } from "../../../shared/version.ts";
import type { HostStatus } from "./host-supervisor.ts";
import type { UpdateOffer } from "./self-update.ts";

export type TrayAction = "open" | "download-newer-version" | "install-update" | "restart-host" | "toggle-background" | "toggle-open-at-login" | "quit";

const trayActions: readonly string[] = ["open", "download-newer-version", "install-update", "restart-host", "toggle-background", "toggle-open-at-login", "quit"] satisfies TrayAction[];
export const isTrayAction = (action: unknown): action is TrayAction => typeof action === "string" && trayActions.includes(action);

export type TrayItem =
  | { type: "separator" }
  | { type: "normal"; label: string; action?: TrayAction; enabled?: boolean; checked?: boolean };

export interface TrayState {
  status: HostStatus | "starting";
  hostRunsInBackground: boolean;
  openAtLogin: boolean;
  newerVersion: NewerVersion | null;
  update: UpdateOffer | null;
}

const statusLabels: Record<TrayState["status"], string> = {
  starting: "Host: starting...",
  stopped: "Host: not running",
  owned: "Host: running, started by this app",
  external: "Host: running, started elsewhere",
  background: "Host: running in the background",
};

function updateItems(update: UpdateOffer | null): TrayItem[] {
  if (!update) return [];
  if (update.blockedBy) return [{ type: "normal", label: `Mirador ${update.version} is out: ${update.blockedBy}`, enabled: false }];
  return [{ type: "normal", label: `Restart to update to Mirador ${update.version}`, action: "install-update" }];
}

/** A release links to its download page, unless the app updates itself to it; new commits on a checkout's upstream are only told. */
function newerVersionItems(newerVersion: NewerVersion | null, update: UpdateOffer | null): TrayItem[] {
  if (!newerVersion || (update && newerVersion.kind === "release")) return [];
  if (newerVersion.kind === "release") return [{ type: "normal", label: `${newerVersionLabel(newerVersion)}: download`, action: "download-newer-version" }];
  return [{ type: "normal", label: newerVersionLabel(newerVersion), enabled: false }];
}

export function trayMenu(state: TrayState): TrayItem[] {
  const restartable = state.status !== "external" && state.status !== "starting";
  return [
    { type: "normal", label: statusLabels[state.status], enabled: false },
    { type: "normal", label: `Mirador ${MIRADOR_VERSION}`, enabled: false },
    ...updateItems(state.update),
    ...newerVersionItems(state.newerVersion, state.update),
    { type: "normal", label: "Open", action: "open" },
    { type: "separator" },
    { type: "normal", label: restartable ? "Restart host" : "Restart host (not started by this app)", action: "restart-host", enabled: restartable },
    { type: "normal", label: "Run host in the background", action: "toggle-background", checked: state.hostRunsInBackground },
    { type: "normal", label: "Open at login", action: "toggle-open-at-login", checked: state.openAtLogin },
    { type: "separator" },
    { type: "normal", label: "Quit", action: "quit" },
  ];
}

export const trayTitle = (waitingCount: number) => (waitingCount > 0 ? String(waitingCount) : "");

/** On macOS a tray title is text beside the icon, kept for the waiting count; Linux panels show it as the icon's tooltip. */
export const firstTrayTitle = (platform: NodeJS.Platform, appName: string) => (platform === "darwin" ? "" : appName);

export function restartDetail(appName: string, runningTurns: number): string {
  if (runningTurns === 0) return `${appName} closes and opens again.`;
  const turns = runningTurns === 1 ? "turn" : "turns";
  return `${appName} closes and opens again. ${runningTurns} running ${turns} will stop.`;
}
