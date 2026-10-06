export const CANVAS_MESSAGE_SOURCE = "mirador-canvas";

export type CanvasFrameMessage =
  | { source: typeof CANVAS_MESSAGE_SOURCE; itemId: string; kind: "error"; message: string }
  | { source: typeof CANVAS_MESSAGE_SOURCE; itemId: string; kind: "rendered"; errors: string[] }
  /** `overflowWidth` is how wide the content wants to be, when that is wider than the frame. */
  | { source: typeof CANVAS_MESSAGE_SOURCE; itemId: string; kind: "size"; height: number; overflowWidth: number | null }
  /** A wheel turn the page has no use for, for the panel behind it to take instead. */
  | { source: typeof CANVAS_MESSAGE_SOURCE; itemId: string; kind: "wheel"; deltaX: number; deltaY: number; deltaMode: number }
  | {
      source: typeof CANVAS_MESSAGE_SOURCE;
      itemId: string;
      kind: "key";
      key: string;
      code: string;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      typing: boolean;
    };

export function isCanvasFrameMessage(data: unknown): data is CanvasFrameMessage {
  return typeof data === "object" && data !== null && (data as { source?: unknown }).source === CANVAS_MESSAGE_SOURCE;
}

export function canvasImportMap(assetsOrigin: string) {
  return {
    imports: {
      three: `${assetsOrigin}/three/build/three.module.js`,
      "three/webgpu": `${assetsOrigin}/three/build/three.webgpu.js`,
      "three/tsl": `${assetsOrigin}/three/build/three.tsl.js`,
      "three/addons/": `${assetsOrigin}/three/addons/`,
    },
  };
}

export function canvasContentSecurityPolicy(assetsOrigin: string) {
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${assetsOrigin}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src data: blob:",
    "worker-src blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

function frameReporter(itemId: string) {
  return `(() => {
  const itemId = ${JSON.stringify(itemId)};
  const errors = [];
  const post = (message) => parent.postMessage({ source: ${JSON.stringify(CANVAS_MESSAGE_SOURCE)}, itemId, ...message }, "*");
  const record = (message) => {
    if (errors.length >= 20 || /ResizeObserver loop/.test(message)) return;
    errors.push(message);
    post({ kind: "error", message });
  };
  addEventListener("error", (event) => {
    const element = event.target;
    if (element && element !== window && (element.src || element.href)) record("Failed to load " + (element.src || element.href));
    else record(event.message + (event.lineno ? " (line " + event.lineno + ")" : ""));
  }, true);
  addEventListener("unhandledrejection", (event) => record("Unhandled promise rejection: " + ((event.reason && event.reason.message) || event.reason)));
  addEventListener("securitypolicyviolation", (event) => record("Blocked by the canvas sandbox: " + event.effectiveDirective + " " + event.blockedURI));
  const consoleError = console.error;
  console.error = (...args) => {
    record(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
    consoleError.apply(console, args);
  };
  addEventListener("load", () => setTimeout(() => post({ kind: "rendered", errors }), 1500));
  const reportSize = () => {
    const root = document.documentElement;
    const leftMargin = document.body ? parseFloat(getComputedStyle(document.body).marginLeft) || 0 : 0;
    const overflowWidth = root.scrollWidth > root.clientWidth ? Math.ceil(root.scrollWidth + leftMargin) : null;
    post({ kind: "size", height: Math.ceil(root.getBoundingClientRect().height), overflowWidth });
  };
  new ResizeObserver(reportSize).observe(document.documentElement);
  addEventListener("load", reportSize);
  const hasRoom = (node, axis, delta) => {
    const position = axis === "scrollTop" ? node.scrollTop : node.scrollLeft;
    const size = axis === "scrollTop" ? node.clientHeight : node.clientWidth;
    const total = axis === "scrollTop" ? node.scrollHeight : node.scrollWidth;
    return delta < 0 ? position > 0 : delta > 0 ? position + size < total - 1 : false;
  };
  const takesTheWheel = (node, deltaX, deltaY, isRoot) => {
    const style = isRoot ? null : getComputedStyle(node);
    const scrolls = (overflow) => isRoot || style[overflow] === "auto" || style[overflow] === "scroll";
    return (scrolls("overflowY") && hasRoom(node, "scrollTop", deltaY)) || (scrolls("overflowX") && hasRoom(node, "scrollLeft", deltaX));
  };
  const pageScrolls = (event) => {
    const root = document.scrollingElement || document.documentElement;
    if (takesTheWheel(root, event.deltaX, event.deltaY, true)) return true;
    for (let node = event.target; node instanceof Element && node !== root; node = node.parentElement) {
      if (takesTheWheel(node, event.deltaX, event.deltaY, false)) return true;
    }
    return false;
  };
  // A page that fits its frame has nothing to scroll, and WebKit does not pass the wheel on to the panel holding it.
  addEventListener("wheel", (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.ctrlKey || pageScrolls(event)) return;
    event.preventDefault();
    post({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode });
  }, { passive: false });
  addEventListener("keydown", (event) => {
    if (!event.isTrusted || !(event.metaKey || event.ctrlKey || event.altKey)) return;
    const target = event.target;
    const typing = Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));
    const { key, code, metaKey, ctrlKey, altKey, shiftKey } = event;
    post({ kind: "key", key, code, metaKey, ctrlKey, altKey, shiftKey, typing });
  }, true);
})();`;
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/**
 * Wraps agent HTML (a fragment or a full document) so our CSP, import map and error
 * reporter come before anything the agent wrote; the parser folds the agent's own
 * <html>/<head> tags into the already-open elements.
 */
export function buildCanvasDocument(html: string, itemId: string, assetsOrigin: string) {
  const withoutDoctype = html.replace(/^\s*<!doctype[^>]*>/i, "");
  return [
    "<!doctype html>",
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(canvasContentSecurityPolicy(assetsOrigin))}">`,
    '<meta charset="utf-8">',
    `<script type="importmap">${JSON.stringify(canvasImportMap(assetsOrigin))}</script>`,
    `<script>${frameReporter(itemId)}</script>`,
    "<style>html{background:#fff;color:#111;font-family:system-ui,sans-serif}</style>",
    withoutDoctype,
  ].join("\n");
}
