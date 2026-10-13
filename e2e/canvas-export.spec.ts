import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, callCanvasTool, openSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const host = new TestHost(5440);
const assetsOrigin = `http://127.0.0.1:${host.port + 1}`;
const cdnD3 = /https:\/\/cdn\.jsdelivr\.net\/npm\/d3@\d+\.\d+\.\d+\/dist\/d3\.min\.js/;

test.beforeAll(() => host.start());
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const chart = {
  title: "Sales by région",
  html: `<style>h1 { color: rgb(200, 0, 0); }</style><script src="${assetsOrigin}/d3.min.js"></script><h1 id="drawn">waiting</h1>
<script>document.getElementById("drawn").textContent = "Drawn with d3 " + d3.version;</script>`,
};

const canvasPage = (page: Page) => page.locator(".canvas-frame.show iframe").contentFrame();
const exportToggle = (page: Page) => page.locator(".canvas-header:visible .page-export-toggle");
const exportStatus = (page: Page) => page.locator(".page-export-status");
const saveForm = (page: Page) => page.locator(".page-save");
const savedFile = join(host.projectDir, "docs", "sales-by-region.html");

async function exportBy(page: Page, action: string) {
  await exportToggle(page).click();
  await page.getByRole("menu", { name: "Export the page" }).getByRole("menuitem", { name: action }).click();
}

async function saveToProject(page: Page) {
  await exportBy(page, "Save to project…");
  await saveForm(page).getByRole("button", { name: "Save" }).click();
}

async function chooseLibraries(page: Page, option: string) {
  const settings = await openSettings(page, "Canvas");
  await settings.getByLabel("Libraries").selectOption({ label: option });
  await settings.getByRole("button", { name: "Close" }).click();
}

test("a page the agent showed can be copied as an image or HTML, downloaded, and saved into the project, with its libraries from a CDN or inside it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  await callCanvasTool(host, conversationId, "show", chart);
  await expect(canvasPage(page).locator("#drawn")).toHaveText(/^Drawn with d3 \d/);

  await test.step("Copy HTML puts a page of its own on the clipboard, loading D3 from the CDN", async () => {
    await exportBy(page, "Copy HTML");
    await expect(exportStatus(page)).toHaveText("Copied the HTML");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^<!doctype html>/);
    expect(copied).toContain("<title>Sales by région</title>");
    expect(copied).toMatch(cdnD3);
    expect(copied).not.toContain(assetsOrigin);
  });

  await test.step("Copy as image puts a PNG of the page, in its own colours, on the clipboard", async () => {
    await exportBy(page, "Copy as image");
    await expect(exportStatus(page)).toHaveText("Copied as an image", { timeout: 30_000 });
    const image = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const bitmap = await createImageBitmap(await item!.getType("image/png"));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const redPixels = pixels.filter((red, index) => index % 4 === 0 && red > 150 && pixels[index + 1]! < 60 && pixels[index + 2]! < 60).length;
      return { types: item!.types, width: bitmap.width, height: bitmap.height, redPixels };
    });
    expect(image.types).toContain("image/png");
    expect(image.width).toBeGreaterThan(100);
    expect(image.height).toBeGreaterThan(20);
    expect(image.redPixels, "the page's own red title is drawn").toBeGreaterThan(200);
  });

  await test.step("Download saves the same page, named after its title", async () => {
    const downloading = page.waitForEvent("download");
    await exportBy(page, "Download");
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("sales-by-region.html");
    expect(readFileSync(await download.path(), "utf8")).toMatch(cdnD3);
    await expect(exportStatus(page)).toHaveText("Downloaded");
  });

  await test.step("Save to project writes it into the project at the path offered", async () => {
    await exportBy(page, "Save to project…");
    await expect(saveForm(page).getByLabel("Save in the project as")).toHaveValue("docs/sales-by-region.html");
    await saveForm(page).getByRole("button", { name: "Save" }).click();
    await expect(exportStatus(page)).toHaveText("Saved to docs/sales-by-region.html");
    expect(readFileSync(savedFile, "utf8")).toMatch(cdnD3);
  });

  await test.step("a path outside the project is refused, and the form stays for another", async () => {
    await exportBy(page, "Save to project…");
    await saveForm(page).getByLabel("Save in the project as").fill("../outside.html");
    await saveForm(page).getByRole("button", { name: "Save" }).click();
    await expect(saveForm(page).getByRole("alert")).toHaveText('"../outside.html" is not a file inside the project folder.');
    expect(existsSync(join(host.projectDir, "..", "outside.html"))).toBe(false);
    await page.keyboard.press("Escape");
    await expect(saveForm(page)).toHaveCount(0);
  });

  await test.step("with libraries inside the file, saving over the earlier file asks first, then puts D3 in it", async () => {
    await chooseLibraries(page, "Inside the file: works offline, but Mermaid adds about 3 MB");
    await saveToProject(page);
    await expect(saveForm(page).getByRole("alert")).toHaveText("docs/sales-by-region.html is already there. Replace it?");
    expect(readFileSync(savedFile, "utf8")).toMatch(cdnD3);
    await saveForm(page).getByRole("button", { name: "Replace" }).click();
    await expect(exportStatus(page)).toHaveText("Saved to docs/sales-by-region.html");
    const saved = readFileSync(savedFile, "utf8");
    expect(saved).toContain("https://d3js.org");
    expect(saved).not.toMatch(/<script[^>]*src=[^>]*d3\.min\.js/);
  });

  await test.step("only a shown page offers Export: not the Changes tab over it", async () => {
    await page.locator(".canvas-header:visible .changes-toggle").click();
    await expect(exportToggle(page)).toHaveCount(0);
  });
});
