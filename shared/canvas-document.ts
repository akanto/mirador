export const CANVAS_MESSAGE_SOURCE = "vcs-canvas";

export type CanvasFrameMessage =
  | { source: typeof CANVAS_MESSAGE_SOURCE; itemId: string; kind: "error"; message: string }
  | { source: typeof CANVAS_MESSAGE_SOURCE; itemId: string; kind: "rendered"; errors: string[] }
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

function errorReporter(itemId: string) {
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
    `<script>${errorReporter(itemId)}</script>`,
    "<style>html{background:#fff;color:#111;font-family:system-ui,sans-serif}</style>",
    withoutDoctype,
  ].join("\n");
}
