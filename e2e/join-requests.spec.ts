import { expect, test, type Locator } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { allowNotifications, notificationsShown, openSettings, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const networkOrigin = "https://127.0.0.1:5206";
/** On the network with its own certificate authority, which the laptop learns as it asks to join. */
const server = new TestHost(5204, {
  environment: { MIRADOR_NETWORK: "on", MIRADOR_PUBLIC_ORIGIN: networkOrigin, MIRADOR_PUBLIC_CANVAS_ORIGIN: "https://127.0.0.1:5207" },
});
const laptop = new TestHost(5208);

test.beforeAll(async () => {
  await Promise.all([server.start(), laptop.start()]);
});
test.afterAll(async () => {
  await Promise.all([server.stop(), laptop.stop()]);
  await Promise.all([server.cleanUp(), laptop.cleanUp()]);
});

async function numberShownIn(join: Locator) {
  const shown = join.getByRole("status", { name: "Waiting for approval" }).locator(".join-number");
  await expect(shown).toHaveText(/^\d{3} \d{3}$/);
  return (await shown.textContent())!;
}

const anotherNumber = (number: string) => number.replace(/\d$/, (digit) => String((Number(digit) + 1) % 10));

test("another Mirador asks to join over HTTPS, and gets in once someone at the machine types the number it shows", async ({ page, browser }) => {
  const serverPage = await browser.newPage();
  await allowNotifications(serverPage);
  await signIn(serverPage, server);
  const prompt = serverPage.getByRole("alertdialog", { name: /^Mirador on .+ asks to join$/ });

  await signIn(page, laptop);
  await page.locator(".sidebar").getByRole("button", { name: "Machines…" }).click();
  const machines = page.getByRole("dialog", { name: "Machines" });
  await machines.getByLabel("Name").fill("Server");
  await machines.getByLabel("Address or invite link").fill(networkOrigin);
  await machines.getByRole("button", { name: "Add", exact: true }).click();
  await machines.locator(".machine-list li", { hasText: "Server" }).getByRole("button", { name: "Open", exact: true }).click();
  const join = page.getByRole("region", { name: "Join Server" });
  const askToJoin = join.getByRole("button", { name: "Ask to join" });

  await test.step("the machine's own screen gets a notification, and can deny the request", async () => {
    await askToJoin.click();
    await numberShownIn(join);
    await expect(prompt).toContainText("From 127.0.0.1");
    expect(await notificationsShown(serverPage)).toEqual([
      {
        title: expect.stringMatching(/^Mirador on .+ asks to join Mirador$/),
        body: "From 127.0.0.1. Open Mirador to approve it by typing the number it shows.",
        tag: "about-this-machine",
        closed: false,
      },
    ]);
    await prompt.getByRole("button", { name: "Deny" }).click();
    await expect(prompt).toHaveCount(0);
    await expect(join.locator(".join-problem")).toHaveText("Server denied the request. If the number was typed there wrongly, ask again.");
  });

  await test.step("a wrong number denies it too", async () => {
    await askToJoin.click();
    const number = await numberShownIn(join);
    await prompt.getByLabel("Number it shows").fill(anotherNumber(number));
    await prompt.getByRole("button", { name: "Approve" }).click();
    await expect(serverPage.locator(".notice")).toHaveText("That is not the number the device shows, so its request was denied. It can ask again.");
    await expect(prompt).toHaveCount(0);
    await expect(join.locator(".join-problem")).toHaveText("Server denied the request. If the number was typed there wrongly, ask again.");
  });

  await test.step("the number the laptop shows lets it in, and the machine shows in its place", async () => {
    await askToJoin.click();
    const number = await numberShownIn(join);
    await prompt.getByLabel("Number it shows").fill(number);
    await prompt.getByRole("button", { name: "Approve" }).click();
    await expect(page.frameLocator('iframe[title="Server"]').getByRole("button", { name: "Settings…" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Machines" }).getByRole("button", { name: "Server" })).not.toHaveClass(/away/);
    const settings = await openSettings(serverPage, "Devices");
    await expect(settings.locator(".device-name", { hasText: /^Mirador on / })).toHaveCount(1);
  });
});

test("a browser on the network asks to join, and is signed in once someone at the machine types the number it shows", async ({ browser }) => {
  const serverPage = await browser.newPage();
  await signIn(serverPage, server);
  const phone = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await phone.goto(networkOrigin);
  await phone.getByLabel("Name this device").fill("Phone");
  await phone.getByRole("button", { name: "Ask to join" }).click();
  const number = await numberShownIn(phone.locator(".join-machine"));

  const prompt = serverPage.getByRole("alertdialog", { name: "Phone asks to join" });
  await prompt.getByLabel("Number it shows").fill(number.replace(" ", ""));
  await prompt.getByRole("button", { name: "Approve" }).click();
  await expect(phone.getByRole("button", { name: "Settings…" })).toBeVisible();
  await expect(prompt).toHaveCount(0);
});

test("mirador approve on the machine lets in a browser that asks, while no page of the machine is open", async ({ browser }) => {
  const phone = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await phone.goto(networkOrigin);
  await phone.getByLabel("Name this device").fill("Tablet");
  await phone.getByRole("button", { name: "Ask to join" }).click();
  const number = await numberShownIn(phone.locator(".join-machine"));

  const approve = spawnSync(join(import.meta.dirname, "..", "bin", "mirador"), ["approve"], {
    env: { ...process.env, MIRADOR_DATA_DIR: server.dataDir },
    input: `${number}\n`,
    encoding: "utf8",
  });
  expect(approve.stdout).toContain("Approved. Tablet gets in when it next checks, within seconds.");
  await expect(phone.getByRole("button", { name: "Settings…" })).toBeVisible();
});
