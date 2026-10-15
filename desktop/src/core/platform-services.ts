import { AutostartEntry, autostartEntryPath } from "./autostart.ts";
import { BackgroundHostAgent, type BackgroundHost } from "./background-host.ts";
import { hostAgentLabel, launchAgentPath, openAtLoginLabel } from "./launch-agents.ts";
import { LaunchAgent } from "./launchd.ts";
import { OpenAtLogin, type LoginItem } from "./open-at-login.ts";
import { hostServiceName, HostUserService, userUnitPath } from "./systemd.ts";

export interface PlatformContext {
  platform: NodeJS.Platform;
  appName: string;
  port: number;
  home: string;
  configHome: string;
  appPath: string | null;
  shell: string;
  overrides: Record<string, string>;
  hostLog: string;
}

export interface PlatformServices {
  openAtLogin: LoginItem;
  background: BackgroundHost;
}

const notOnWindowsYet = (what: string) => new Error(`${what} is not available on Windows yet.`);

const noLoginItem: LoginItem = {
  available: false,
  enable() {
    throw notOnWindowsYet("Opening Mirador at login");
  },
  disable() {},
};

const noBackgroundHost: BackgroundHost = {
  isLoaded: async () => false,
  ensureLoaded: async () => {
    throw notOnWindowsYet("Running the host in the background");
  },
  restart: async () => {},
  remove: async () => {},
};

/**
 * launchd LaunchAgents on macOS; on Linux a systemd user service for the host and an XDG autostart entry for the app.
 * Windows has neither yet, so there the app runs the host it owns.
 */
export function platformServices(context: PlatformContext): PlatformServices {
  const { platform, appName, port, home, configHome, appPath, shell, overrides, hostLog } = context;
  const backgroundEnvironment = { shell, overrides, logPath: hostLog };
  if (platform === "linux") {
    return {
      openAtLogin: new AutostartEntry(autostartEntryPath(configHome, port), { appName, overrides }, appPath),
      background: new HostUserService(port, userUnitPath(configHome, hostServiceName(port)), backgroundEnvironment),
    };
  }
  if (platform === "win32") return { openAtLogin: noLoginItem, background: noBackgroundHost };
  const agentAt = (label: string) => new LaunchAgent(label, launchAgentPath(home, label), process.getuid!());
  return {
    openAtLogin: new OpenAtLogin(agentAt(openAtLoginLabel(port)), appPath, overrides),
    background: new BackgroundHostAgent(agentAt(hostAgentLabel(port)), backgroundEnvironment),
  };
}
