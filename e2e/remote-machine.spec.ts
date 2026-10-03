import { connect, createServer, type Server } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, openSettings, signIn, workspaceCard } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const PUBLIC_PORT = 5163;
const PUBLIC_CANVAS_PORT = 5164;
const publicOrigin = `http://localhost:${PUBLIC_PORT}`;
/** The server other devices reach at its public address. */
const host = new TestHost(5165, {
  environment: { MIRADOR_PUBLIC_ORIGIN: publicOrigin, MIRADOR_PUBLIC_CANVAS_ORIGIN: `http://localhost:${PUBLIC_CANVAS_PORT}` },
});
/** The user's own computer, which opens the server as one of its machines. */
const laptop = new TestHost(5161);

/** Stands in for tailscale serve: another address in front of the host, which keeps listening on 127.0.0.1 only. */
function forward(fromPort: number, toPort: number) {
  const server = createServer((client) => {
    const upstream = connect(toPort, "127.0.0.1");
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
    client.pipe(upstream).pipe(client);
  });
  return new Promise<Server>((resolve) => server.listen(fromPort, "127.0.0.1", () => resolve(server)));
}

let forwarders: Server[] = [];

test.beforeAll(async () => {
  await Promise.all([host.start(), laptop.start()]);
  forwarders = await Promise.all([forward(PUBLIC_PORT, host.port), forward(PUBLIC_CANVAS_PORT, host.port + 1)]);
});
test.afterAll(async () => {
  forwarders.forEach((server) => server.close());
  await Promise.all([host.stop(), laptop.stop()]);
  await Promise.all([host.cleanUp(), laptop.cleanUp()]);
});

async function inviteLinkFrom(page: Page) {
  const settings = await openSettings(page);
  await settings.getByRole("button", { name: "Invite a device" }).click();
  return { settings, link: (await settings.locator(".invite-link").textContent())! };
}

test("another device joins the machine at its public address with an invite, and revoking it signs it out", async ({ page, browser }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const { settings, link } = await inviteLinkFrom(page);
  expect(link).toMatch(new RegExp(`^${publicOrigin}/#/join/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$`));

  const phone = await (await browser.newContext()).newPage();
  await test.step("a device without an invite is asked for one", async () => {
    await phone.goto(publicOrigin);
    await expect(phone.getByRole("heading", { name: "Join this machine" })).toBeVisible();
  });

  await test.step("the invite link joins the device, which then works with the machine's workspaces", async () => {
    await phone.goto(link);
    await expect(workspaceCard(phone, host.projectDir)).toBeVisible();
    await expect(settings.locator(".device-list li")).toHaveCount(1);
    await expect(settings.locator(".device-name")).toHaveText(/^Chrome on /);
  });

  await test.step("a used invite lets nobody else in", async () => {
    const stranger = await (await browser.newContext()).newPage();
    await stranger.goto(link);
    await expect(stranger.locator(".join-problem")).toHaveText("This invite code is wrong, used or expired. Ask for a new one.");
  });

  await test.step("revoking the device signs it out at once", async () => {
    await settings.getByRole("button", { name: /^Revoke / }).click();
    await settings.getByRole("button", { name: /^Confirm: Revoke / }).click();
    await expect(phone.getByRole("heading", { name: "Join this machine" })).toBeVisible();
    await expect(settings.locator(".device-list .device-none")).toBeVisible();
  });
});

test("the laptop keeps the server among its machines, and joins it with the invite link pasted for its address", async ({ page, browser }) => {
  const server = await browser.newPage();
  await signIn(server, host);
  const { link } = await inviteLinkFrom(server);

  await signIn(page, laptop);
  await page.getByRole("button", { name: "Machines…" }).click();
  const machines = page.getByRole("dialog", { name: "Machines" });
  await machines.getByLabel("Name").fill("Home server");
  await machines.getByLabel("Address or invite link").fill(link);
  const opened = page.waitForEvent("popup");
  await machines.getByRole("button", { name: "Add and join" }).click();
  const machineTab = await opened;
  await expect(machineTab.getByText("No conversation selected")).toBeVisible();
  await expect(machines.locator(".machine-list li")).toHaveText(/Home server\s*http:\/\/localhost:5163/);

  await machines.getByLabel("Address or invite link").fill(`${publicOrigin}/`);
  await expect(machines.getByText("This machine is already in the list.")).toBeVisible();
  await expect(machines.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
});

test("pages of other sites cannot join for their visitors", async () => {
  const otherOrigin = await fetch(`${publicOrigin}/join`, {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ code: "AAAA-AAAA-AAAA" }),
  });
  expect(await otherOrigin.text()).toBe("forbidden origin");
});
