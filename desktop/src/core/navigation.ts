/** Everything outside the app's own origins is blocked in the window and handed to the browser instead. */
export const navigationRules = (allowedOrigins: string[]) => ["^*", ...allowedOrigins.map((origin) => `${origin}/*`), "about:*"];

function webUrl(text: unknown) {
  try {
    const url = new URL(String(text));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export const openedWindowUrl = (detail: unknown) => webUrl((detail as { url?: unknown } | null)?.url);

/** The webview reports a blocked navigation as a JSON string of the target url and whether the rules allowed it. */
export function blockedNavigationUrl(detail: unknown) {
  try {
    const { url, allowed } = JSON.parse(String(detail));
    return allowed === false ? webUrl(url) : null;
  } catch {
    return null;
  }
}
