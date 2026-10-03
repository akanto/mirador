import { expect, test } from "@playwright/test";
import { addWorkspace, callCanvasTool, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(4710);

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("rejects browsers and clients without the right credentials", async ({ page }) => {
  await page.goto(`${host.origin}/`);
  await expect(page.getByRole("heading", { name: "Join this machine" })).toBeVisible();

  expect((await fetch(`${host.origin}/auth?token=wrong`, { redirect: "manual" })).status).toBe(403);

  const signedIn = await fetch(host.authUrl, { redirect: "manual" });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  expect(signedIn.headers.get("set-cookie")).toContain("HttpOnly");
  expect(signedIn.headers.get("set-cookie")).toContain("SameSite=Strict");

  for (const socketPath of ["/ws", "/notifications"]) {
    const upgrade = (headers: Record<string, string>) => fetch(`${host.origin}${socketPath}`, { headers }).then(({ status }) => status);
    expect(await upgrade({ Origin: "http://evil.example", Cookie: cookie })).toBe(403);
    expect(await upgrade({ Origin: "null", Cookie: cookie })).toBe(403);
    expect(await upgrade({ Origin: host.origin })).toBe(401);
  }

  const mcp = (headers: Record<string, string>) =>
    fetch(`${host.origin}/mcp/anything`, { method: "POST", headers, body: "{}" }).then(({ status }) => status);
  expect(await mcp({})).toBe(401);
  expect(await mcp({ Authorization: "Bearer wrong" })).toBe(401);
  expect(await mcp({ Authorization: `Bearer ${host.mcpToken}`, Origin: host.origin })).toBe(403);

  const scriptMessage = (headers: Record<string, string>) =>
    fetch(`${host.origin}/sessions/anything/messages`, { method: "POST", headers, body: "hello" }).then(({ status }) => status);
  expect(await scriptMessage({})).toBe(401);
  expect(await scriptMessage({ Authorization: `Bearer ${host.mcpToken}` })).toBe(401);
  expect(await scriptMessage({ Authorization: `Bearer ${host.scriptToken}`, Origin: host.origin })).toBe(403);
  expect(await scriptMessage({ Authorization: `Bearer ${host.scriptToken}` })).toBe(404);

  const images = `${host.origin}/conversations/00000000-0000-0000-0000-000000000000/images`;
  const addImage = (headers: Record<string, string>) =>
    fetch(images, { method: "POST", headers: { "Content-Type": "image/png", ...headers }, body: "png" }).then(({ status }) => status);
  const readImage = (headers: Record<string, string>) => fetch(`${images}/x.png`, { headers }).then(({ status }) => status);
  expect(await addImage({ Origin: host.origin })).toBe(401);
  expect(await addImage({ Origin: "http://evil.example", Cookie: cookie })).toBe(403);
  expect(await addImage({ Cookie: cookie })).toBe(403);
  expect(await readImage({})).toBe(401);
  expect(await readImage({ Cookie: cookie, "Sec-Fetch-Site": "cross-site" })).toBe(403);
  expect(await readImage({ Cookie: cookie })).toBe(404);
});

test("a hostile canvas page cannot reach the host, the parent page or the network", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);

  const hostile = `<h1>hostile</h1>
<script>
  fetch("${host.origin}/").then(() => console.error("LEAK fetch succeeded"), () => {});
  const socket = new WebSocket("ws://127.0.0.1:${host.port}/ws");
  socket.onopen = () => console.error("LEAK websocket opened");
  try { parent.document.title; console.error("LEAK parent document readable"); } catch {}
  try { if (document.cookie) console.error("LEAK cookie " + document.cookie); } catch {}
  try { top.location.href = "http://example.com/"; } catch {}
  try { if (window.open("http://example.com/")) console.error("LEAK popup opened"); } catch {}
  const image = new Image();
  image.src = "http://example.com/exfiltrate.png";
</script>`;
  const result = await callCanvasTool(host, conversationId, "show", { title: "Hostile", html: hostile });

  expect(result).toContain("reported errors");
  expect(result).toContain("connect-src");
  expect(result).toContain("img-src");
  expect(result).not.toContain("LEAK");
  await expect(page.locator(".canvas-frame.show iframe").contentFrame().getByRole("heading", { name: "hostile" })).toBeVisible();
  expect(new URL(page.url()).origin).toBe(host.origin);
  expect(page.context().pages()).toHaveLength(1);
});

test("canvas pages can load the bundled three.js, D3 and Mermaid", async ({ page }) => {
  await signIn(page, host);
  await page.locator(".workspace li").first().click();
  await expect(page.locator(".canvas-title")).toHaveText("Hostile");
  const conversationId = page.url().match(/#\/c\/(.+)$/)![1]!;

  const assetsOrigin = `http://127.0.0.1:${host.port + 1}`;
  const html = `<div id="out"></div>
<pre class="mermaid">graph TD; A-->B</pre>
<script src="${assetsOrigin}/d3.min.js"></script>
<script src="${assetsOrigin}/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true });</script>
<script type="module">
  import * as THREE from "three";
  import { OrbitControls } from "three/addons/controls/OrbitControls.js";
  document.getElementById("out").textContent = ["three " + THREE.REVISION, typeof OrbitControls, "d3 " + d3.version].join(" | ");
</script>`;
  const result = await callCanvasTool(host, conversationId, "show", { title: "Libraries", html });

  expect(result).toContain("rendered without script errors");
  const frame = page.locator(".canvas-frame.show iframe").contentFrame();
  await expect(frame.locator("#out")).toContainText(/three \d+ \| function \| d3 7/);
  await expect(frame.locator("pre.mermaid svg")).toBeVisible();
});
