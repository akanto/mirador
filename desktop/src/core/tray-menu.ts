import { newerVersionLabel, type NewerVersion } from "../../../shared/newer-version.ts";
import { MIRADOR_VERSION } from "../../../shared/version.ts";
import type { HostStatus } from "./host-supervisor.ts";

export type TrayAction = "open" | "download-newer-version" | "restart-host" | "toggle-background" | "toggle-open-at-login" | "quit";

const trayActions: readonly string[] = ["open", "download-newer-version", "restart-host", "toggle-background", "toggle-open-at-login", "quit"] satisfies TrayAction[];
export const isTrayAction = (action: unknown): action is TrayAction => typeof action === "string" && trayActions.includes(action);

export type TrayItem =
  | { type: "separator" }
  | { type: "normal"; label: string; action?: TrayAction; enabled?: boolean; checked?: boolean };

export interface TrayState {
  status: HostStatus | "starting";
  hostRunsInBackground: boolean;
  openAtLogin: boolean;
  newerVersion: NewerVersion | null;
}

const statusLabels: Record<TrayState["status"], string> = {
  starting: "Host: starting...",
  stopped: "Host: not running",
  owned: "Host: running, started by this app",
  external: "Host: running, started elsewhere",
  background: "Host: running in the background",
};

/** A release links to its download page; new commits on a checkout's upstream are only told. */
function newerVersionItems(newerVersion: NewerVersion | null): TrayItem[] {
  if (!newerVersion) return [];
  if (newerVersion.kind === "release") return [{ type: "normal", label: `${newerVersionLabel(newerVersion)}: download`, action: "download-newer-version" }];
  return [{ type: "normal", label: newerVersionLabel(newerVersion), enabled: false }];
}

export function trayMenu(state: TrayState): TrayItem[] {
  const restartable = state.status !== "external" && state.status !== "starting";
  return [
    { type: "normal", label: statusLabels[state.status], enabled: false },
    { type: "normal", label: `Mirador ${MIRADOR_VERSION}`, enabled: false },
    ...newerVersionItems(state.newerVersion),
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
