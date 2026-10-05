import Electrobun, { BrowserWindow, Utils } from "electrobun/main";
import { navigationRules } from "../core/navigation.ts";
import { setDockIconVisible } from "./dock.ts";

interface HostMessageEvent {
  data?: { detail?: unknown };
}

const WINDOW_SIZE = { width: 1280, height: 800 };

export class MainWindow {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly title: string,
    private readonly appOrigin: string,
    /** The canvas and the other machines, which the page shows in frames. */
    private readonly framedOrigins: string[],
    private readonly onPageMessage: (detail: unknown) => void,
  ) {}

  get isOpen() {
    return this.window !== null;
  }

  bringToFront() {
    this.window?.show();
    this.window?.activate();
  }

  open(url: string) {
    setDockIconVisible(true);
    if (this.window) return this.bringToFront();
    // sandbox keeps Electrobun's bridge secret out of every frame, including the agents' canvas iframes.
    const window = new BrowserWindow({ title: this.title, url, frame: WINDOW_SIZE, sandbox: true });
    // The navigationRules constructor option is ignored by Electrobun 2.0.2; only this call takes effect.
    window.webview.setNavigationRules(navigationRules([this.appOrigin, ...this.framedOrigins]));
    window.on("close", () => {
      this.window = null;
      setDockIconVisible(false);
    });
    // Blocked navigations and new windows are not opened in the browser: any frame can cause or forge those events, the
    // agents' canvas pages included. The app's own page asks for its links with the nonce instead (web/outside-links.ts).
    Electrobun.events.on(`host-message-${window.webview.id}`, (event: unknown) => this.onPageMessage((event as HostMessageEvent).data?.detail));
    this.window = window;
  }

  runInPage(script: string) {
    this.window?.webview.executeJavascript(script);
  }

  openInBrowser(url: string) {
    if (!url.startsWith(`${this.appOrigin}/`)) Utils.openExternal(url);
  }
}
