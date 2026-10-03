import { expect, test, type APIRequestContext } from "@playwright/test";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { addWorkspace, addWorkspaceFromSidebar, callCanvasTool, openSettings, signIn, startConversation, workspaceCard } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const networkOrigin = "https://127.0.0.1:5192";
const networkCanvasOrigin = "https://127.0.0.1:5193";
/** On the network from its environment, at an address its own certificate covers wherever the tests run. */
const host = new TestHost(5190, {
  environment: { MIRADOR_NETWORK: "on", MIRADOR_PUBLIC_ORIGIN: networkOrigin, MIRADOR_PUBLIC_CANVAS_ORIGIN: networkCanvasOrigin },
});
const hostSwitchedInSettings = new TestHost(5196);

test.beforeAll(async () => {
  await Promise.all([host.start(), hostSwitchedInSettings.start()]);
});
test.afterAll(async () => {
  await Promise.all([host.stop(), hostSwitchedInSettings.stop()]);
  await Promise.all([host.cleanUp(), hostSwitchedInSettings.cleanUp()]);
});

const authorityOf = (testHost: TestHost) => readFileSync(join(testHost.dataDir, "tls", "authority.pem"), "utf8");

/** Verified against the host's own authority alone, as a machine that pinned it connects. */
function fetchTrusting(authority: string, url: string) {
  return new Promise<string>((resolve, reject) => {
    httpsRequest(url, { ca: authority }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve(body));
    })
      .on("error", reject)
      .end();
  });
}

async function statusOf(request: APIRequestContext, method: "get" | "post", url: string) {
  return (await request[method](url, { failOnStatusCode: false })).status();
}

test("a device joins over HTTPS with an invite link that names the host's certificate authority, and the network serves nothing only this machine may use", async ({
  page,
  browser,
}) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const settings = await openSettings(page);
  const networkSwitch = settings.getByLabel("Reachable on the network, over HTTPS at port 5192");
  await expect(networkSwitch).toBeChecked();
  await expect(networkSwitch).toBeDisabled();

  const authority = authorityOf(host);
  const fingerprint = createHash("sha256").update(new X509Certificate(authority).raw).digest("base64url");
  await settings.getByRole("button", { name: "Invite a device" }).click();
  const link = (await settings.locator(".invite-link").textContent())!;
  expect(link).toMatch(new RegExp(`^${networkOrigin}/#/join/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/${fingerprint}$`));

  await test.step("the host's own certificate authority vouches for both of its network ports", async () => {
    expect(await fetchTrusting(authority, `${networkOrigin}/mirador-ca.pem`)).toBe(authority);
    expect(await fetchTrusting(authority, `${networkCanvasOrigin}/d3.min.js`)).toContain("d3js.org");
  });

  const phone = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await test.step("the invite link joins a phone over HTTPS", async () => {
    await phone.goto(link);
    await expect(workspaceCard(phone, host.projectDir)).toBeVisible();
  });

  await test.step("the network port has no sign-in link, MCP endpoint or script messages", async () => {
    expect(await statusOf(phone.request, "get", `${networkOrigin}/auth?token=anything`)).toBe(404);
    expect(await statusOf(phone.request, "post", `${networkOrigin}/mcp/some-conversation`)).toBe(404);
    expect(await statusOf(phone.request, "post", `${networkOrigin}/sessions/some-session/messages`)).toBe(404);
  });
});

test("the host's own page loads canvas libraries from this machine, though agents were given the network address", async ({ page }) => {
  await signIn(page, host);
  await addWorkspaceFromSidebar(page, host.projectDir);
  const conversationId = await startConversation(page);
  const html = `<div id="out"></div><script src="${networkCanvasOrigin}/d3.min.js"></script><script>document.getElementById("out").textContent = "d3 " + d3.version;</script>`;
  const result = await callCanvasTool(host, conversationId, "show", { title: "Chart", html });

  expect(result, "this browser does not trust the host's own certificate authority").toContain("rendered without script errors");
  await expect(page.locator(".canvas-frame.show iframe").contentFrame().locator("#out")).toHaveText(/^d3 7/);
});

test("turning the network on in Settings takes effect when the host restarts", async ({ page }) => {
  await signIn(page, hostSwitchedInSettings);
  let settings = await openSettings(page);
  const networkSwitch = () => settings.getByLabel("Reachable on the network, over HTTPS at port 5198");
  await networkSwitch().check();
  await expect(settings.getByText("Saved. The host uses it from its next start.")).toBeVisible();
  expect(JSON.parse(readFileSync(join(hostSwitchedInSettings.dataDir, "config.json"), "utf8"))).toEqual({ network: true });

  await settings.getByRole("button", { name: "Restart host" }).click();
  await expect(settings, "the page reloads once the restarted host answers").toBeHidden({ timeout: 30_000 });
  settings = await openSettings(page);
  await expect(networkSwitch()).toBeChecked();
  await expect(settings.getByRole("link", { name: "certificate authority" })).toHaveAttribute("href", "/mirador-ca.pem");
  await expect(settings.getByText(/On the network it now uses https:\/\/.+:5198\./)).toBeVisible();
  const authority = authorityOf(hostSwitchedInSettings);
  expect(await fetchTrusting(authority, "https://127.0.0.1:5198/mirador-ca.pem")).toBe(authority);

  await networkSwitch().uncheck();
  await expect(settings.getByText("Saved. The host uses it from its next start.")).toBeVisible();
});
