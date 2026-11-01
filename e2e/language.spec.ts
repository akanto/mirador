import { expect, test } from "@playwright/test";
import { openSettings, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost();

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

test("choosing Magyar in Settings shows Mirador in Hungarian after the page reloads, and English comes back the same way", async ({ page }) => {
  await signIn(page, host);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const settings = await openSettings(page);

  await Promise.all([page.waitForEvent("load"), settings.getByLabel("Language").selectOption("hu")]);

  await expect(page.locator("html")).toHaveAttribute("lang", "hu");
  await page.getByRole("button", { name: "Settings…" }).click();
  const beallitasok = page.getByRole("dialog", { name: "Beállítások" });
  await expect(beallitasok.getByRole("tablist", { name: "Beállítási oldalak" }).getByRole("tab")).toHaveText([
    "Megjelenés",
    "Beszélgetések",
    "Ágensek",
    "Hang",
    "Terminál",
    "Vászon",
    "Bővítmények",
    "Elrendezés",
    "Eszközök",
    "Értesítések",
    "Névjegy",
  ]);
  await expect(beallitasok.getByRole("radiogroup", { name: "Téma" }).getByRole("radio")).toHaveText(["Világos", "Sötét", "Rendszer szerint"]);
  await expect(beallitasok.locator(".picture-choice").filter({ hasText: "Téma" })).toHaveAttribute("data-hint", "Világos, sötét, vagy a rendszerbeállítást követi.");

  await beallitasok.getByRole("tab", { name: "Terminál" }).click();
  await expect(beallitasok.getByLabel("Visszagörgethető sorok").locator("option").first()).toHaveText(/^1\s?000 sor$/);

  await beallitasok.getByRole("tab", { name: "Megjelenés" }).click();
  await Promise.all([page.waitForEvent("load"), beallitasok.getByLabel("Nyelv").selectOption("en")]);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect((await openSettings(page)).getByRole("radiogroup", { name: "Theme" })).toBeVisible();
});
