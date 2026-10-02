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
  uid: number;
  appPath: string | null;
  shell: string;
  overrides: Record<string, string>;
  hostLog: string;
}

export interface PlatformServices {
  openAtLogin: LoginItem;
  background: BackgroundHost;
}

/** launchd LaunchAgents on macOS; on Linux a systemd user service for the host and an XDG autostart entry for the app. */
export function platformServices(context: PlatformContext): PlatformServices {
  const { platform, appName, port, home, configHome, uid, appPath, shell, overrides, hostLog } = context;
  const backgroundEnvironment = { shell, overrides, logPath: hostLog };
  if (platform === "linux") {
    return {
      openAtLogin: new AutostartEntry(autostartEntryPath(configHome, port), { appName, overrides }, appPath),
      background: new HostUserService(port, userUnitPath(configHome, hostServiceName(port)), backgroundEnvironment),
    };
  }
  const agentAt = (label: string) => new LaunchAgent(label, launchAgentPath(home, label), uid);
  return {
    openAtLogin: new OpenAtLogin(agentAt(openAtLoginLabel(port)), appPath, overrides),
    background: new BackgroundHostAgent(agentAt(hostAgentLabel(port)), backgroundEnvironment),
  };
}
