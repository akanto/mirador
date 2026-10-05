import { Utils } from "electrobun/main";
import { readFileSync } from "node:fs";
import { hostArgv } from "../core/host-command.ts";
import { HostNotifications, nativeNotification } from "../core/host-notifications.ts";
import { hostAnswers, spawnDetachedHost } from "../core/host-process.ts";
import { HostSupervisor, type HostStatus } from "../core/host-supervisor.ts";
import type { LoginItem } from "../core/open-at-login.ts";
import { platformServices } from "../core/platform-services.ts";
import { PidFileOnDisk, systemProcesses } from "../core/processes.ts";
import { authUrl, hostEnvironmentOverrides, type DataPaths, type Runtime } from "../core/runtime.ts";
import type { SettingsStore } from "../core/settings.ts";
import type { TrayAction, TrayState } from "../core/tray-menu.ts";
import { giveNonceScript, pageRequest, showMenuScript, windowMenu } from "../core/window-menu.ts";
import { AppTray } from "./app-tray.ts";
import { setDockIconVisible } from "./dock.ts";
import { MainWindow } from "./main-window.ts";

const STATUS_POLL_MILLISECONDS = 10_000;
const showsMenuInWindow = process.platform === "linux";

export interface DesktopEnvironment {
  appName: string;
  runtime: Runtime;
  paths: DataPaths;
  settings: SettingsStore;
  shell: string;
  home: string;
  configHome: string;
  uid: number;
  appPath: string | null;
  isPackaged: boolean;
}

export class DesktopApp {
  private readonly supervisor: HostSupervisor;
  private readonly openAtLogin: LoginItem;
  private readonly window: MainWindow;
  private readonly tray: AppTray;
  private readonly notifications: HostNotifications;
  private status: TrayState["status"] = "starting";
  private busy = false;
  /** Only the window's own page gets it, never a frame in it, so only that page makes the app act. */
  private readonly pageNonce = crypto.randomUUID();

  constructor(private readonly environment: DesktopEnvironment) {
    const { appName, runtime, paths, settings, shell, home, configHome, uid, appPath } = environment;
    const overrides = hostEnvironmentOverrides(runtime, home);
    const { openAtLogin, background } = platformServices({
      platform: process.platform,
      appName,
      port: runtime.port,
      home,
      configHome,
      uid,
      appPath,
      shell,
      overrides,
      hostLog: paths.hostLog,
    });
    this.openAtLogin = openAtLogin;
    this.supervisor = new HostSupervisor({
      port: runtime.port,
      logPath: paths.hostLog,
      settings,
      hostAnswers: () => hostAnswers(runtime.origin),
      spawnHost: (current) => spawnDetachedHost(hostArgv(shell, current.bun, overrides), current.hostDirectory, paths.hostLog),
      processes: systemProcesses,
      pidFile: new PidFileOnDisk(paths.ownedHostPid),
      background,
      pause: Bun.sleep,
    });
    this.window = new MainWindow(environment.appName, runtime.origin, [runtime.canvasOrigin, ...runtime.relayOrigins], (detail) => this.answerPage(detail));
    this.tray = new AppTray((action) => void this.handle(action));
    this.notifications = new HostNotifications({
      origin: runtime.origin,
      token: () => this.browserTokenOnceWritten(),
      show: (notification) => Utils.showNotification(nativeNotification(notification, process.platform)),
    });
    this.renderTray();
  }

  async start() {
    await this.reconcileOpenAtLogin();
    this.notifications.start();
    await this.openWindow();
    setInterval(() => void this.refreshStatus(), STATUS_POLL_MILLISECONDS);
  }

  async openWindow() {
    if (this.window.isOpen) return this.window.bringToFront();
    await this.busyWith("starting", async () => {
      await this.supervisor.start();
      this.window.open(authUrl(this.environment.runtime, this.browserToken()));
    });
    if (!this.window.isOpen) setDockIconVisible(false);
  }

  stopOwnedHost() {
    this.supervisor.terminateOwned();
  }

  private browserToken() {
    return readFileSync(this.environment.paths.browserToken, "utf8").trim();
  }

  private browserTokenOnceWritten() {
    try {
      return this.browserToken();
    } catch {
      return null;
    }
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
    this.tray.render(this.trayState());
    this.showMenuInWindow();
  }

  private trayState(): TrayState {
    const { hostRunsInBackground, openAtLogin } = this.environment.settings.current();
    return { status: this.status, hostRunsInBackground, openAtLogin };
  }

  private showMenuInWindow() {
    if (!showsMenuInWindow || !this.window.isOpen) return;
    this.window.runInPage(showMenuScript({ nonce: this.pageNonce, items: windowMenu(this.trayState()) }));
  }

  private answerPage(detail: unknown) {
    const request = pageRequest(detail, this.pageNonce);
    if (request?.type === "nonce") this.window.runInPage(giveNonceScript(this.pageNonce));
    if (request?.type === "open-link") this.window.openInBrowser(request.url);
    if (!showsMenuInWindow) return;
    if (request?.type === "menu") this.showMenuInWindow();
    if (request?.type === "action") void this.handle(request.action);
  }

  private async report(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await Utils.showMessageBox({ type: "error", title: this.environment.appName, message, buttons: ["OK"] });
  }
}
