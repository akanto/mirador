import Electrobun, { BrowserWindow, Utils } from "electrobun/main";
import { blockedNavigationUrl, navigationRules, openedWindowUrl } from "../core/navigation.ts";

interface WebviewEvent {
  data?: { detail?: unknown };
}

const WINDOW_SIZE = { width: 1280, height: 800 };

export class MainWindow {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly title: string,
    private readonly appOrigin: string,
    private readonly canvasOrigin: string,
  ) {}

  get isOpen() {
    return this.window !== null;
  }

  bringToFront() {
    this.window?.show();
    this.window?.activate();
  }

  open(url: string) {
    Utils.setDockIconVisible(true);
    if (this.window) return this.bringToFront();
    // sandbox keeps Electrobun's bridge secret out of every frame, including the agents' canvas iframes.
    const window = new BrowserWindow({ title: this.title, url, frame: WINDOW_SIZE, sandbox: true });
    // The navigationRules constructor option is ignored by Electrobun 2.0.2; only this call takes effect.
    window.webview.setNavigationRules(navigationRules([this.appOrigin, this.canvasOrigin]));
    window.on("close", () => {
      this.window = null;
      Utils.setDockIconVisible(false);
    });
    window.webview.on("will-navigate", (event) => this.openInBrowser(blockedNavigationUrl((event as WebviewEvent).data?.detail)));
    Electrobun.events.on(`new-window-open-${window.webview.id}`, (event: unknown) => this.openInBrowser(openedWindowUrl((event as WebviewEvent).data?.detail)));
    this.window = window;
  }

  private openInBrowser(url: string | null) {
    if (url && !url.startsWith(`${this.appOrigin}/`)) Utils.openExternal(url);
  }
}
