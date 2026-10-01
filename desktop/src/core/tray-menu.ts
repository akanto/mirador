import type { HostStatus } from "./host-supervisor.ts";

export type TrayAction = "open" | "restart-host" | "toggle-background" | "toggle-open-at-login" | "quit";

export type TrayItem =
  | { type: "separator" }
  | { type: "normal"; label: string; action?: TrayAction; enabled?: boolean; checked?: boolean };

export interface TrayState {
  status: HostStatus | "starting";
  hostRunsInBackground: boolean;
  openAtLogin: boolean;
}

const statusLabels: Record<TrayState["status"], string> = {
  starting: "Host: starting...",
  stopped: "Host: not running",
  owned: "Host: running, started by this app",
  external: "Host: running, started elsewhere",
  background: "Host: running in the background",
};

export function trayMenu(state: TrayState): TrayItem[] {
  const restartable = state.status !== "external" && state.status !== "starting";
  return [
    { type: "normal", label: statusLabels[state.status], enabled: false },
    { type: "normal", label: "Open", action: "open" },
    { type: "separator" },
    { type: "normal", label: restartable ? "Restart host" : "Restart host (not started by this app)", action: "restart-host", enabled: restartable },
    { type: "normal", label: "Run host in the background", action: "toggle-background", checked: state.hostRunsInBackground },
    { type: "normal", label: "Open at login", action: "toggle-open-at-login", checked: state.openAtLogin },
    { type: "separator" },
    { type: "normal", label: "Quit", action: "quit" },
  ];
}
