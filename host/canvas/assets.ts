import { dirname, join, resolve, sep } from "node:path";

const packageDir = (name: string) => dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dir));

const mounts: Record<string, string> = {
  "/three/build/": join(packageDir("three"), "build"),
  "/three/addons/": join(packageDir("three"), "examples", "jsm"),
};

const singleFiles: Record<string, string> = {
  "/d3.min.js": join(packageDir("d3"), "dist", "d3.min.js"),
  "/mermaid.min.js": join(packageDir("mermaid"), "dist", "mermaid.min.js"),
};

/** Canvas pages run in opaque-origin iframes, so module imports from here need CORS. */
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" };

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
      const file = resolveAsset(new URL(request.url).pathname);
      if (!file || !(await Bun.file(file).exists())) return new Response("not found", { status: 404, headers: corsHeaders });
      return new Response(Bun.file(file), { headers: corsHeaders });
    },
  });
}
