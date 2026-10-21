import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { openSettings, signIn } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const files = [
  { path: "config.json", content: Buffer.from("{}"), lfs: false },
  { path: "model.safetensors", content: Buffer.alloc(40_000, 7), lfs: true },
  { path: "README.md", content: Buffer.from("# Model"), lfs: false },
];
const sha256 = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const gitBlobSha1 = (content: Buffer) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

let slowly = false;
let corrupted = false;
let downloaded: string[] = [];

/** Answers as Hugging Face does for any model: its files at a revision, and each file, sent slowly when a step asks for time to look. */
const huggingFace = createServer(async (request, response) => {
  const path = decodeURIComponent(request.url ?? "");
  if (/^\/api\/models\/[^/]+\/[^/]+\/tree\/[0-9a-f]+\?recursive=true$/.test(path)) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(files.map(({ path, content, lfs }) => ({ type: "file", path, size: content.length, oid: gitBlobSha1(content), ...(lfs && { lfs: { oid: sha256(content) } }) }))));
    return;
  }
  const asked = path.match(/\/resolve\/[0-9a-f]+\/(.+)$/)?.[1];
  const file = files.find((each) => each.path === asked);
  if (!file) return response.writeHead(404).end();
  downloaded.push(path);
  const content = corrupted && file.lfs ? Buffer.alloc(file.content.length, 1) : file.content;
  if (!slowly) return response.end(content);
  for (let sent = 0; sent < content.length && !response.destroyed; sent += 1_000) {
    response.write(content.subarray(sent, sent + 1_000));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  response.end();
});

const host = new TestHost({
  environment: () => ({
    MIRADOR_VOICE_MODELS_URL: `http://127.0.0.1:${(huggingFace.address() as AddressInfo).port}`,
    MIRADOR_VOICE_PYTHON: "/usr/bin/true",
  }),
});

test.beforeAll(async () => {
  await new Promise<void>((resolve) => huggingFace.listen(0, "127.0.0.1", resolve));
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  huggingFace.close();
});

test("Settings → Voice set up voice on this Mac: the download shows its progress, Cancel stops it, Remove takes it away, and a failed download says why", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, host);
  const settings = await openSettings(page, "Voice");
  const thisMac = settings.getByRole("group", { name: "Voice on this Mac" });
  const setUpButton = thisMac.getByRole("button", { name: "Set up voice on this Mac" });
  const progress = thisMac.getByRole("progressbar", { name: "Setting up voice on this Mac" });

  await test.step("it says how much disk it takes, with the voice model or without", async () => {
    await expect(thisMac).toContainText("They take about 18.9 GB of disk.");
    await thisMac.getByLabel(/Include the voice model/).uncheck();
    await expect(thisMac).toContainText("They take about 3.5 GB of disk.");
  });

  await test.step("the download shows how far it is, and Cancel stops it", async () => {
    slowly = true;
    await setUpButton.click();
    await expect(progress).toBeVisible();
    await expect(thisMac).toContainText("Downloading the models");
    await thisMac.getByRole("button", { name: "Cancel" }).click();
    await expect(setUpButton).toBeVisible();
    await expect(progress).toHaveCount(0);
  });

  await test.step("once set up, it offers the voice model, and every window shows it", async () => {
    slowly = false;
    downloaded = [];
    await setUpButton.click();
    await expect(thisMac).toContainText(/Set up with speech recognition, using \d+\.\d GB\./);
    await expect(thisMac.getByRole("button", { name: "Add the voice model (15.4 GB)" })).toBeVisible();
    expect(downloaded.some((path) => path.includes("gemma")), "the voice model was left out").toBe(false);
    expect(downloaded.some((path) => path.endsWith("README.md")), "readmes are left out").toBe(false);

    const otherWindow = await page.context().newPage();
    await otherWindow.goto(page.url());
    await expect((await openSettings(otherWindow, "Voice")).getByRole("group", { name: "Voice on this Mac" })).toContainText("Set up with speech recognition");
    await otherWindow.close();
  });

  await test.step("Remove asks again, then takes it away", async () => {
    await thisMac.getByRole("button", { name: "Remove voice from this Mac" }).click();
    await thisMac.getByRole("button", { name: "Confirm: Remove voice from this Mac" }).click();
    await expect(setUpButton).toBeVisible();
  });

  await test.step("a download that comes in different is thrown away, and setup says so", async () => {
    corrupted = true;
    await setUpButton.click();
    await expect(thisMac.getByRole("alert")).toContainText("came in different from what was expected");
    await expect(thisMac.getByRole("button", { name: "Try again" })).toBeVisible();
    corrupted = false;
    await thisMac.getByRole("button", { name: "Try again" }).click();
    await expect(thisMac).toContainText("Set up with speech recognition");
  });
});
