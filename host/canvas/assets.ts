import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { HERE_PATH } from "../addresses.ts";
import { CANVAS_SHELL_PAGE, CANVAS_SHELL_PATH, canvasShellPolicy, CAPTURE_LIBRARY_PATH } from "../../shared/canvas-document.ts";

const packageDir = (name: string) => dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dir));

export function assetPackageVersion(name: "d3" | "mermaid" | "three"): string {
  return JSON.parse(readFileSync(join(packageDir(name), "package.json"), "utf8")).version;
}

const mounts: Record<string, string> = {
  "/three/build/": join(packageDir("three"), "build"),
  "/three/addons/": join(packageDir("three"), "examples", "jsm"),
};

const singleFiles: Record<string, string> = {
  "/d3.min.js": join(packageDir("d3"), "dist", "d3.min.js"),
  "/mermaid.min.js": join(packageDir("mermaid"), "dist", "mermaid.min.js"),
  [CAPTURE_LIBRARY_PATH]: join(packageDir("modern-screenshot"), "dist", "index.mjs"),
};

/** Canvas pages run in opaque-origin iframes, so module imports from here need CORS. */
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" };

/** Not cached: after an update, the panel and the shell it writes into must speak the same version. The policy names the address each request came in on, so it is per request. */
const shellHeaders = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };

export function resolveAsset(pathname: string): string | null {
  if (singleFiles[pathname]) return singleFiles[pathname];
  const mount = Object.keys(mounts).find((prefix) => pathname.startsWith(prefix));
  if (!mount) return null;
  const root = mounts[mount]!;
  const file = resolve(root, decodeURIComponent(pathname.slice(mount.length)));
  return file.startsWith(root + sep) ? file : null;
}

/** On 127.0.0.1 for this machine's pages; with a certificate, on every network for other devices' pages. */
export function serveCanvasAssets(port: number, certificate: { chain: string; key: string } | null = null) {
  return Bun.serve({
    hostname: certificate ? "0.0.0.0" : "127.0.0.1",
    port,
    ...(certificate && { tls: { cert: certificate.chain, key: certificate.key } }),
    async fetch(request) {
      if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
      const pathname = new URL(request.url).pathname;
      if (pathname === HERE_PATH) return Response.json({ mirador: true }, { headers: corsHeaders });
      if (pathname === CANVAS_SHELL_PATH)
        return new Response(CANVAS_SHELL_PAGE, { headers: { ...shellHeaders, "Content-Security-Policy": canvasShellPolicy(new URL(request.url).origin) } });
      const file = resolveAsset(pathname);
      if (!file || !(await Bun.file(file).exists())) return new Response("not found", { status: 404, headers: corsHeaders });
      return new Response(Bun.file(file), { headers: corsHeaders });
    },
  });
}
