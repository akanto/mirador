import { Utils } from "electrobun/main";
import { readFileSync } from "node:fs";
import { BackgroundHostAgent } from "../core/background-host.ts";
import { hostArgv } from "../core/host-command.ts";
import { HostSupervisor, type HostStatus } from "../core/host-supervisor.ts";
import { hostAgentLabel, launchAgentPath, openAtLoginLabel } from "../core/launch-agents.ts";
import { LaunchAgent } from "../core/launchd.ts";
import { OpenAtLogin } from "../core/open-at-login.ts";
import { PidFileOnDisk, systemProcesses } from "../core/processes.ts";
import { hostAnswers, spawnDetachedHost } from "../core/host-process.ts";
import { authUrl, hostEnvironmentOverrides, type DataPaths, type Runtime } from "../core/runtime.ts";
import type { SettingsStore } from "../core/settings.ts";
import type { TrayAction, TrayState } from "../core/tray-menu.ts";
import { AppTray } from "./app-tray.ts";
import { MainWindow } from "./main-window.ts";

const STATUS_POLL_MILLISECONDS = 10_000;

export interface DesktopEnvironment {
  appName: string;
  runtime: Runtime;
  paths: DataPaths;
  settings: SettingsStore;
  shell: string;
  home: string;
  uid: number;
  appPath: string | null;
  isPackaged: boolean;
}

export class DesktopApp {
  private readonly supervisor: HostSupervisor;
  private readonly openAtLogin: OpenAtLogin;
  private readonly window: MainWindow;
  private readonly tray: AppTray;
  private status: TrayState["status"] = "starting";
  private busy = false;

  constructor(private readonly environment: DesktopEnvironment) {
    const { runtime, paths, settings, shell, home, uid, appPath } = environment;
    const overrides = hostEnvironmentOverrides(runtime, home);
    const agentAt = (label: string) => new LaunchAgent(label, launchAgentPath(home, label), uid);
    this.openAtLogin = new OpenAtLogin(agentAt(openAtLoginLabel(runtime.port)), appPath, overrides);
    this.supervisor = new HostSupervisor({
      port: runtime.port,
      logPath: paths.hostLog,
      settings,
      hostAnswers: () => hostAnswers(runtime.origin),
      spawnHost: (current) => spawnDetachedHost(hostArgv(shell, current.bun, overrides), current.hostDirectory, paths.hostLog),
      processes: systemProcesses,
      pidFile: new PidFileOnDisk(paths.ownedHostPid),
      background: new BackgroundHostAgent(agentAt(hostAgentLabel(runtime.port)), { shell, overrides, logPath: paths.hostLog }),
      pause: Bun.sleep,
    });
    this.window = new MainWindow(environment.appName, runtime.origin, runtime.canvasOrigin);
    this.tray = new AppTray((action) => void this.handle(action));
    this.renderTray();
  }

  async start() {
    await this.reconcileOpenAtLogin();
    await this.openWindow();
    setInterval(() => void this.refreshStatus(), STATUS_POLL_MILLISECONDS);
  }

  async openWindow() {
    if (this.window.isOpen) return this.window.bringToFront();
    await this.busyWith("starting", async () => {
      await this.supervisor.start();
      this.window.open(authUrl(this.environment.runtime, this.browserToken()));
    });
    if (!this.window.isOpen) Utils.setDockIconVisible(false);
  }

  stopOwnedHost() {
    this.supervisor.terminateOwned();
  }

  private browserToken() {
    return readFileSync(this.environment.paths.browserToken, "utf8").trim();
  }

  private async handle(action: TrayAction) {
    if (action === "open") return this.openWindow();
    if (action === "quit") return void Utils.quit();
    if (action === "restart-host") return this.busyWith("starting", () => this.supervisor.restart());
    if (action === "toggle-background") return this.busyWith("starting", () => this.toggleBackground());
    return this.toggleOpenAtLogin();
  }

  private toggleBackground() {
    return this.environment.settings.current().hostRunsInBackground ? this.supervisor.disableBackground() : this.supervisor.enableBackground();
  }

  private async toggleOpenAtLogin() {
    const enable = !this.environment.settings.current().openAtLogin;
    try {
      if (enable) this.openAtLogin.enable();
      else await this.openAtLogin.disable();
      this.environment.settings.update({ openAtLogin: enable });
    } catch (error) {
      await this.report(error);
    }
    this.renderTray();
  }

  private async reconcileOpenAtLogin() {
    if (!this.environment.isPackaged || !this.openAtLogin.available) return;
    try {
      if (this.environment.settings.current().openAtLogin) this.openAtLogin.enable();
      else await this.openAtLogin.disable();
    } catch (error) {
      await this.report(error);
    }
  }

  private async busyWith(pendingStatus: TrayState["status"], work: () => Promise<unknown>) {
    this.busy = true;
    this.status = pendingStatus;
    this.renderTray();
    try {
      await work();
    } catch (error) {
      await this.report(error);
    } finally {
      this.busy = false;
      await this.refreshStatus();
    }
  }

  private async refreshStatus() {
    if (this.busy) return;
    const status: HostStatus = await this.supervisor.status().catch(() => "stopped");
    if (this.busy || status === this.status) return;
    this.status = status;
    this.renderTray();
  }

  private renderTray() {
    const { hostRunsInBackground, openAtLogin } = this.environment.settings.current();
    this.tray.render({ status: this.status, hostRunsInBackground, openAtLogin });
  }

  private async report(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await Utils.showMessageBox({ type: "error", title: this.environment.appName, message, buttons: ["OK"] });
  }
}
