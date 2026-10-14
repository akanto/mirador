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
    }
  /** The page drawn as a PNG, as the panel asked for it to copy. */
  | { source: typeof CANVAS_MESSAGE_SOURCE; itemId: string; kind: "captured"; requestId: string; image: Blob }
  | { source: typeof CANVAS_MESSAGE_SOURCE; itemId: string; kind: "capture-failed"; requestId: string; message: string };

export function isCanvasFrameMessage(data: unknown): data is CanvasFrameMessage {
  return typeof data === "object" && data !== null && (data as { source?: unknown }).source === CANVAS_MESSAGE_SOURCE;
}

/** Light or dark, as the panel shows: canvas pages resolve their light-dark() colours against it. */
export type CanvasTheme = "light" | "dark";

/** Asks a canvas page to draw itself as a PNG; it answers with a "captured" or "capture-failed" message. */
export function canvasCaptureMessage(requestId: string) {
  return { source: CANVAS_MESSAGE_SOURCE, kind: "capture", requestId };
}

/** Where a canvas page loads the library that draws it as an image, from the canvas assets. */
export const CAPTURE_LIBRARY_PATH = "/modern-screenshot.mjs";

/** Tells a canvas page the panel's theme changed, since a sandboxed frame does not inherit the panel's color-scheme. */
export function canvasThemeMessage(theme: CanvasTheme) {
  return { source: CANVAS_MESSAGE_SOURCE, kind: "theme", theme };
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

/**
 * Whether text reads on what is behind it, as plain JS for the frame. `readableTextColor(color, backgrounds, scheme)`
 * takes computed colours, the backgrounds from the text's element outwards, and gives the theme text colour to show
 * the text in instead, or null when it reads as it is or cannot be judged.
 */
export const TEXT_CONTRAST_SCRIPT = `
  const MINIMUM_TEXT_CONTRAST = 2.5;
  const THEME_TEXT = [[23, 23, 23], [236, 236, 236]];
  const THEME_PAGE = { light: [255, 255, 255], dark: [17, 17, 17] };
  const parseColor = (value) => {
    const match = /^rgba?\\(([^)]*)\\)$/.exec(value);
    if (!match) return null;
    const parts = match[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
    return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (layer, ground) => layer.rgb.map((channel, index) => channel * layer.alpha + ground[index] * (1 - layer.alpha));
  const luminance = (rgb) => {
    const [red, green, blue] = rgb.map((channel) => {
      const share = channel / 255;
      return share <= 0.03928 ? share / 12.92 : ((share + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const contrastRatio = (one, other) => {
    const [lighter, darker] = [luminance(one), luminance(other)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  };
  const readableTextColor = (color, backgrounds, scheme) => {
    const text = parseColor(color);
    if (!text || text.alpha < 0.5) return null;
    const layers = backgrounds.map(parseColor);
    if (layers.includes(null)) return null;
    const ground = layers.reduceRight((below, layer) => over(layer, below), THEME_PAGE[scheme]);
    if (contrastRatio(over(text, ground), ground) >= MINIMUM_TEXT_CONTRAST) return null;
    const best = THEME_TEXT.reduce((most, each) => (contrastRatio(each, ground) > contrastRatio(most, ground) ? each : most));
    return "rgb(" + best.join(", ") + ")";
  };
`;

function frameReporter(itemId: string, theme: CanvasTheme, assetsOrigin: string) {
  return `(() => {
  const itemId = ${JSON.stringify(itemId)};
  const errors = [];
  const post = (message) => parent.postMessage({ source: ${JSON.stringify(CANVAS_MESSAGE_SOURCE)}, itemId, ...message }, "*");
  // Important, so the panel's theme wins over a page's own color-scheme (often "light dark", which follows the system) from the first paint.
  const colorScheme = document.createElement("style");
  const showIn = (theme) => { colorScheme.textContent = ":root{color-scheme:" + (theme === "dark" ? "dark" : "light") + " !important}"; };
  showIn(${JSON.stringify(theme)});
  document.head.append(colorScheme);
${TEXT_CONTRAST_SCRIPT}
  // Pages often pick colours for one theme only. Text that all but vanishes on its own background takes the theme
  // text colour that reads there; each check gives the text its own colour back first, so a theme change starts afresh.
  const fixedText = new Map();
  const keepTextReadable = () => {
    if (!document.body) return;
    const scheme = getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "light";
    const backgrounds = new Map();
    const layersBehind = (element) => {
      const style = getComputedStyle(element);
      if (style.backgroundImage !== "none") return null;
      const own = style.backgroundColor;
      const parsed = parseColor(own);
      if ((parsed && parsed.alpha === 1) || !element.parentElement) return [own];
      // Out of the flow, it may sit over anything, not just over its ancestors.
      if (style.position === "absolute" || style.position === "fixed") return null;
      const outer = backgroundsOf(element.parentElement);
      return outer && [own, ...outer];
    };
    const backgroundsOf = (element) => {
      if (!backgrounds.has(element)) backgrounds.set(element, layersBehind(element));
      return backgrounds.get(element);
    };
    const hasOwnText = (element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.data.trim());
    const keepReadable = (element) => {
      if (!hasOwnText(element)) return;
      const layers = backgroundsOf(element);
      const color = layers && readableTextColor(getComputedStyle(element).color, layers, scheme);
      if (!color) return;
      fixedText.set(element, { value: element.style.getPropertyValue("color"), priority: element.style.getPropertyPriority("color"), ours: color });
      element.style.setProperty("color", color, "important");
    };
    // Parents before their children, so a child is judged in the colour it inherits once its parent's is fixed.
    keepReadable(document.body);
    const notText = (element) => (element.matches("svg, script, style, noscript, textarea") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, { acceptNode: notText });
    for (let element = walker.nextNode(); element; element = walker.nextNode()) keepReadable(element);
  };
  const restoreTextColours = () => {
    fixedText.forEach(({ value, priority, ours }, element) => {
      if (element.style.getPropertyValue("color") !== ours) return;
      if (value) element.style.setProperty("color", value, priority);
      else element.style.removeProperty("color");
    });
    fixedText.clear();
  };
  let textCheck = 0;
  const textWatcher = new MutationObserver(() => {
    clearTimeout(textCheck);
    textCheck = setTimeout(checkText, 100);
  });
  const checkText = () => {
    if (document.readyState === "loading") return;
    textWatcher.disconnect();
    restoreTextColours();
    keepTextReadable();
    textWatcher.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style"] });
  };
  addEventListener("DOMContentLoaded", checkText);
  addEventListener("load", checkText);
  // The whole page, not only what the frame shows, in the colours it is shown in.
  const capture = async (requestId) => {
    try {
      const { domToBlob } = await import(${JSON.stringify(assetsOrigin + CAPTURE_LIBRARY_PATH)});
      const root = document.documentElement;
      const image = await domToBlob(root, {
        width: root.scrollWidth,
        height: root.scrollHeight,
        scale: devicePixelRatio,
        backgroundColor: getComputedStyle(root).backgroundColor,
        font: false,
        // The library works out the browser's default styles in a frame of its own, which a sandboxed page cannot reach;
        // with a stand-in that has no window, it writes out every style of each element instead.
        sandbox: { remove() {} },
      });
      post({ kind: "captured", requestId, image });
    } catch (error) {
      post({ kind: "capture-failed", requestId, message: String((error && error.message) || error) });
    }
  };
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.source !== ${JSON.stringify(CANVAS_MESSAGE_SOURCE)}) return;
    if (data.kind === "theme") {
      showIn(data.theme);
      checkText();
    }
    if (data.kind === "capture") capture(data.requestId);
  });
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
    const bodyLeft = document.body ? document.body.getBoundingClientRect().left + scrollX : 0;
    const overflowWidth = root.scrollWidth > root.clientWidth ? Math.ceil(root.scrollWidth + bodyLeft) : null;
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
  // The innermost node with room takes the wheel, as the engine picks it; the page itself comes last.
  const scrollingNode = (event) => {
    const root = document.scrollingElement || document.documentElement;
    for (let node = event.target; node instanceof Element && node !== root; node = node.parentElement) {
      if (takesTheWheel(node, event.deltaX, event.deltaY, false)) return node;
    }
    return takesTheWheel(root, event.deltaX, event.deltaY, true) ? root : null;
  };
  const wheelPixels = (delta, deltaMode, page) => delta * (deltaMode === 1 ? 16 : deltaMode === 2 ? page : 1);
  const scrollByTurn = (node, turn) => node.scrollBy({
    left: wheelPixels(turn.deltaX, turn.deltaMode, node.clientWidth),
    top: wheelPixels(turn.deltaY, turn.deltaMode, node.clientHeight),
  });
  // WebKit does not natively scroll these sandboxed srcdoc frames. The first turns on a node show whether the engine
  // scrolls it; where it does not, those turns are made up for and every later one scrolls here at once, so a
  // touchpad's stream of small turns neither lags nor gets lost.
  const engineScrolls = new WeakMap();
  const turnsWhileFindingOut = new WeakMap();
  const scrollWhereTheEngineDoesNot = (node, event) => {
    const known = engineScrolls.get(node);
    if (known === true) return;
    if (known === false) {
      event.preventDefault();
      scrollByTurn(node, event);
      return;
    }
    const turns = turnsWhileFindingOut.get(node);
    if (turns) {
      turns.push(event);
      return;
    }
    turnsWhileFindingOut.set(node, [event]);
    const was = { x: node.scrollLeft, y: node.scrollTop };
    setTimeout(() => {
      const moved = node.scrollLeft !== was.x || node.scrollTop !== was.y;
      engineScrolls.set(node, moved);
      if (!moved) turnsWhileFindingOut.get(node).forEach((turn) => scrollByTurn(node, turn));
      turnsWhileFindingOut.delete(node);
    }, 64);
  };
  // A page that fits its frame has nothing to scroll, and WebKit does not pass the wheel on to the panel holding it.
  addEventListener("wheel", (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.ctrlKey) return;
    const node = scrollingNode(event);
    if (node === null) {
      event.preventDefault();
      post({ kind: "wheel", deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode });
      return;
    }
    scrollWhereTheEngineDoesNot(node, event);
  }, { passive: false });
  const forwardKey = (event) => {
    const target = event.target;
    const typing = Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)));
    const { key, code, metaKey, ctrlKey, altKey, shiftKey } = event;
    post({ kind: "key", key, code, metaKey, ctrlKey, altKey, shiftKey, typing });
  };
  const withModifier = (event) => event.metaKey || event.ctrlKey || event.altKey;
  addEventListener("keydown", (event) => {
    if (event.isTrusted && withModifier(event)) forwardKey(event);
  }, true);
  // Listened to after the page's own handlers, so an Esc that closes something on the page stays with the page.
  addEventListener("keydown", (event) => {
    if (event.isTrusted && event.key === "Escape" && !withModifier(event) && !event.defaultPrevented) forwardKey(event);
  });
})();`;
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** A page in a box among a question's fields keeps its side spacing on html, where a page's own body{margin:0} does not take it away; the body's top and bottom margins stay, to collapse with its first and last elements' as before. */
const PADDED_PAGE_STYLE = "<style>html{padding:0 8px}body{margin-left:0;margin-right:0}</style>";

/**
 * Wraps agent HTML (a fragment or a full document) so our CSP, import map and error
 * reporter come before anything the agent wrote; the parser folds the agent's own
 * <html>/<head> tags into the already-open elements.
 */
export function buildCanvasDocument(html: string, itemId: string, assetsOrigin: string, theme: CanvasTheme, { padded = false } = {}) {
  const withoutDoctype = html.replace(/^\s*<!doctype[^>]*>/i, "");
  return [
    "<!doctype html>",
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(canvasContentSecurityPolicy(assetsOrigin))}">`,
    '<meta charset="utf-8">',
    `<script type="importmap">${JSON.stringify(canvasImportMap(assetsOrigin))}</script>`,
    `<script>${frameReporter(itemId, theme, assetsOrigin)}</script>`,
    "<style>html{background:light-dark(#fff,#111);color:light-dark(#171717,#ececec);font-family:system-ui,sans-serif;overflow-wrap:break-word}</style>",
    ...(padded ? [PADDED_PAGE_STYLE] : []),
    withoutDoctype,
  ].join("\n");
}
