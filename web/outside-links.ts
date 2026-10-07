import { desktopNonce, inDesktopApp, sendToDesktopApp } from "./desktop-bridge.ts";

const OPEN_LINK_MESSAGE = "mirador:open-link";

function webAddress(address: string) {
  if (!URL.canParse(address, location.href)) return null;
  const url = new URL(address, location.href);
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/** The web address of another site that a click on a link goes to, which the browser shows rather than the app's window. */
function outsideLinkOf(event: MouseEvent) {
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  const url = anchor instanceof HTMLAnchorElement ? webAddress(anchor.href) : null;
  return url && url.origin !== location.origin ? url.href : null;
}

function openOutsideLinksWith(open: (url: string) => void, canOpen = () => true) {
  const takeOver = (event: MouseEvent, opens: boolean) => {
    const url = outsideLinkOf(event);
    if (!url || !canOpen()) return;
    event.preventDefault();
    if (opens) open(url);
  };
  const withModifier = (event: MouseEvent) => event.metaKey || event.ctrlKey;
  // Electrobun's preload takes ⌘- and Ctrl-clicks on links before any listener of the page, so those open on the press.
  window.addEventListener("mousedown", (event) => event.button === 0 && withModifier(event) && takeOver(event, true), true);
  window.addEventListener("click", (event) => takeOver(event, !withModifier(event)), true);
  window.addEventListener("auxclick", (event) => event.button === 1 && takeOver(event, true), true);
}

const isOpenLinkMessage = (data: unknown): data is { type: string; url: string } =>
  typeof data === "object" && data !== null && (data as { type?: unknown }).type === OPEN_LINK_MESSAGE && typeof (data as { url?: unknown }).url === "string";

/** A machine of the rail, shown in a frame of this page from its relay, whose page sent the message. */
function machineFrameSending(event: MessageEvent) {
  const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe.machine-frame")];
  return frames.find((frame) => frame.contentWindow === event.source && new URL(frame.src).origin === event.origin);
}

/**
 * Inside the desktop app, links to other sites open in the browser only when this page asks the app with the nonce the
 * app handed it. The window's own navigation events come from any frame, the agents' canvas pages included, so the app
 * opens nothing on them. A machine shown in the rail is a frame of this page, and passes its links on to it.
 */
export function openOutsideLinksInTheBrowser() {
  if (!inDesktopApp()) return;
  if (window.parent !== window) return openOutsideLinksWith((url) => window.parent.postMessage({ type: OPEN_LINK_MESSAGE, url }, "*"));
  const open = (url: string) => {
    const nonce = desktopNonce();
    if (nonce) sendToDesktopApp({ type: "desktop-open-link", nonce, url });
  };
  // An app built before this never hands over a nonce, and still opens links from its window's navigation events.
  openOutsideLinksWith(open, () => desktopNonce() !== null);
  window.addEventListener("message", (event) => {
    if (!isOpenLinkMessage(event.data) || !machineFrameSending(event)) return;
    const url = webAddress(event.data.url);
    if (url) open(url.href);
  });
}
