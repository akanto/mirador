import { expect, test, type Locator } from "@playwright/test";
import jsQR from "jsqr";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openSettings, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5172);
const hostAddressedByEnvironment = new TestHost(5174, {
  environment: { MIRADOR_PUBLIC_ORIGIN: "https://env.example.com", MIRADOR_PUBLIC_CANVAS_ORIGIN: "https://env.example.com:8443" },
});

test.beforeAll(async () => {
  await Promise.all([host.start(), hostAddressedByEnvironment.start()]);
});
test.afterAll(async () => {
  await Promise.all([host.stop(), hostAddressedByEnvironment.stop()]);
  await Promise.all([host.cleanUp(), hostAddressedByEnvironment.cleanUp()]);
});

const addressForm = (settings: Locator) => settings.getByRole("form", { name: "Address on your network" });
const configFile = () => JSON.parse(readFileSync(join(host.dataDir, "config.json"), "utf8"));

async function invite(settings: Locator) {
  await settings.getByRole("button", { name: "Invite a device" }).click();
  return settings.getByLabel("Invite");
}

const inviteQrCode = (invite: Locator) => invite.getByRole("img", { name: "Link as a QR code" });

/** What a phone's camera reads off the QR code: the page draws it on a canvas, and its pixels are decoded here. */
async function scanned(qrCode: Locator) {
  const side = 400;
  const pixels = await qrCode.evaluate(async (svg, side) => {
    const sized = svg.cloneNode(true) as SVGSVGElement;
    sized.setAttribute("width", String(side));
    sized.setAttribute("height", String(side));
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(sized))}`;
    await image.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: side, height: side });
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, side, side).data);
  }, side);
  return jsQR(Uint8ClampedArray.from(pixels), side, side)?.data ?? null;
}

test("an address saved in Settings goes to config.json, and invite links use it once the host restarts", async ({ page }) => {
  await signIn(page, host);
  let settings = await openSettings(page, "Devices");
  let form = addressForm(settings);

  await test.step("both addresses are needed", async () => {
    await form.getByLabel("Address", { exact: true }).fill("https://box.example.ts.net/");
    await form.getByRole("button", { name: "Save address" }).click();
    await expect(form.getByText("Set both Address and Canvas address, or neither.")).toBeVisible();
  });

  await test.step("saving writes config.json, and the host keeps its old address until it restarts", async () => {
    await form.getByLabel("Canvas address").fill("https://box.example.ts.net:8443");
    await form.getByRole("button", { name: "Save address" }).click();
    await expect(settings.getByText("Saved. The host uses it from its next start.")).toBeVisible();
    await expect(form.getByLabel("Address", { exact: true })).toHaveValue("https://box.example.ts.net");
    expect(configFile()).toEqual({ publicOrigin: "https://box.example.ts.net", publicCanvasOrigin: "https://box.example.ts.net:8443" });
    const shownInvite = await invite(settings);
    await expect(shownInvite.locator(".invite-code")).toBeVisible();
    await expect(shownInvite.locator(".invite-link")).toHaveCount(0);
    await expect(inviteQrCode(shownInvite)).toHaveCount(0);
    await expect(shownInvite.locator(".invite-without-link"), "the invite says why it has no link to show").toBeVisible();
  });

  await test.step("after the restart, invites come with a link to the saved address", async () => {
    await settings.getByRole("button", { name: "Restart host" }).click();
    await expect(settings, "the page reloads once the restarted host answers").toBeHidden({ timeout: 30_000 });
    await expect(page.getByText("No conversation selected")).toBeVisible();
    settings = await openSettings(page, "Devices");
    form = addressForm(settings);
    await expect(settings.getByText("Saved. The host uses it from its next start.")).toHaveCount(0);
    const linkedInvite = await invite(settings);
    await expect(linkedInvite.locator(".invite-link")).toHaveText(/^https:\/\/box\.example\.ts\.net\/#\/join\/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await expect(linkedInvite.locator(".invite-without-link")).toHaveCount(0);
  });

  await test.step("emptying both takes the address out of config.json", async () => {
    await form.getByLabel("Address", { exact: true }).fill("");
    await form.getByLabel("Canvas address").fill("");
    await form.getByRole("button", { name: "Save address" }).click();
    await expect(settings.getByText("Saved. The host uses it from its next start.")).toBeVisible();
    expect(configFile()).toEqual({});
  });
});

test("an address the host's environment sets can't be changed in Settings", async ({ page }) => {
  await signIn(page, hostAddressedByEnvironment);
  const form = addressForm(await openSettings(page, "Devices"));
  await expect(form).toContainText("The host's environment sets its address");
  await expect(form.getByLabel("Address", { exact: true })).toHaveValue("https://env.example.com");
  await expect(form.getByLabel("Address", { exact: true })).toBeDisabled();
  await expect(form.getByLabel("Canvas address")).toHaveValue("https://env.example.com:8443");
  await expect(form.getByRole("button", { name: "Save address" })).toBeDisabled();
});

test("an invite link also shows as a QR code, which reads back as the link for the phone app to scan", async ({ page }) => {
  await signIn(page, hostAddressedByEnvironment);
  const shownInvite = await invite(await openSettings(page, "Devices"));
  const link = await shownInvite.locator(".invite-link").textContent();
  expect(link).toMatch(/^https:\/\/env\.example\.com\/#\/join\/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(await scanned(inviteQrCode(shownInvite))).toBe(link);
});
