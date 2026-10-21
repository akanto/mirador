import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { addWorkspace, openSettings, signIn, startConversation } from "./helpers.ts";
import { scratchPath, TestHost, writeCompiledBunProgram } from "./test-host.ts";

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

const scratch = scratchPath("voice-engine");
const engineLog = join(scratch, "engine.log");
const fakePython = join(scratch, "python.exe");

const host = new TestHost({
  environment: () => ({
    MIRADOR_VOICE_MODELS_URL: `http://127.0.0.1:${(huggingFace.address() as AddressInfo).port}`,
    MIRADOR_VOICE_PYTHON: fakePython,
  }),
});

interface EngineEntry {
  module: string;
  pid: number;
  event: string;
  model?: string;
  responseFormat?: string;
  chatTemplateKwargs?: unknown;
}

const engineLogged = (): EngineEntry[] =>
  existsSync(engineLog)
    ? readFileSync(engineLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as EngineEntry)
    : [];

const serverPids = () =>
  engineLogged()
    .filter(({ event }) => event === "start")
    .map(({ pid }) => pid);

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What the composer will send: a clip of 16 kHz mono WAV, here a header without samples. */
async function dictate(page: Page, conversationId: string) {
  return page.evaluate(async (conversationId) => {
    const response = await fetch(`/conversations/${conversationId}/speech`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(44) });
    return { status: response.status, body: await response.text() };
  }, conversationId);
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  writeCompiledBunProgram(scratch, "python", join(import.meta.dirname, "fake-voice-engine.ts"), { FAKE_VOICE_ENGINE_LOG: engineLog, FAKE_VOICE_ENGINE_LOAD_MS: "2000" });
  await new Promise<void>((resolve) => huggingFace.listen(0, "127.0.0.1", resolve));
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  huggingFace.close();
  rmSync(scratch, { recursive: true, force: true });
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

test("Voice on this Mac loads its models when first needed and shows it, and unloads them with the host and on Remove", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const settings = await openSettings(page, "Voice");
  const thisMac = settings.getByRole("group", { name: "Voice on this Mac" });
  const models = thisMac.getByRole("list", { name: "Models on this Mac" });
  const speech = models.getByRole("listitem").filter({ hasText: "Speech recognition" });
  const voiceModel = models.getByRole("listitem").filter({ hasText: "Voice model" });
  const recognitionChoice = settings.getByLabel("Turns speech into text");
  const voiceModelChoice = settings.getByLabel("Translates");

  await test.step("this Mac's voice model is on offer once it is added, and both start unloaded", async () => {
    await expect(voiceModelChoice.getByRole("option", { name: "On this Mac, once set up above" })).toHaveJSProperty("disabled", true);
    await thisMac.getByRole("button", { name: "Add the voice model (15.4 GB)" }).click();
    await expect(thisMac).toContainText("Set up with speech recognition and the voice model");
    await expect(speech).toContainText("Unloaded. It loads again when next needed");
    await expect(voiceModel).toContainText("Unloaded.");
    await recognitionChoice.selectOption({ label: "On this Mac" });
    await voiceModelChoice.selectOption({ label: "On this Mac" });
    await thisMac.getByLabel("Unload after").fill("45");
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("status")).toHaveText("Saved.");
  });

  await test.step("the first dictation loads both, and Settings shows them loading, then loaded", async () => {
    const dictation = dictate(page, conversationId);
    await expect(speech).toContainText("Loading…");
    await expect(voiceModel).toContainText("Loading…");
    const { status, body } = await dictation;
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ text: "Run the e2e tests.", original: "Futtasd le az e2e teszteket.", language: "hu" });
    await expect(speech).toContainText("Loaded. It unloads after 45 minutes unused.");
    await expect(voiceModel).toContainText("Loaded. It unloads after 45 minutes unused.");
  });

  await test.step("the engine was asked for the language it heard, with this Mac's models, and not to think first", async () => {
    const logged = engineLogged();
    expect(logged.find(({ event, module }) => event === "start" && module === "mlx_lm.server")?.model).toMatch(/models\/gemma-4-26b-a4b-it-4bit$/);
    const transcriptions = logged.filter(({ event }) => event === "transcription");
    expect(transcriptions.map(({ responseFormat }) => responseFormat)).toEqual(["json", "verbose_json"]);
    expect(transcriptions.at(-1)?.model).toMatch(/models\/whisper-large-v3-turbo-asr-fp16$/);
    expect(logged.find(({ event }) => event === "chat")).toMatchObject({ model: expect.stringMatching(/models\/gemma-4-26b-a4b-it-4bit$/), chatTemplateKwargs: { enable_thinking: false } });
  });

  await test.step("the models unload when the host stops", async () => {
    const pids = serverPids();
    await host.restart();
    expect(pids.filter(isRunning)).toEqual([]);
    await expect(page.locator(".banner")).toHaveCount(0, { timeout: 30_000 });
    await openSettings(page, "Voice");
    await expect(speech).toContainText("Unloaded.");
    await expect(voiceModel).toContainText("Unloaded.");
  });

  await test.step("Remove unloads them before taking them away, and dictating then says to set voice up again", async () => {
    expect(JSON.parse((await dictate(page, conversationId)).body)).toMatchObject({ text: "Run the e2e tests." });
    await expect(voiceModel).toContainText("Loaded.");
    const pids = serverPids().filter(isRunning);
    expect(pids).toHaveLength(2);
    await thisMac.getByRole("button", { name: "Remove voice from this Mac" }).click();
    await thisMac.getByRole("button", { name: "Confirm: Remove voice from this Mac" }).click();
    await expect(thisMac.getByRole("button", { name: "Set up voice on this Mac" })).toBeVisible();
    expect(pids.filter(isRunning)).toEqual([]);
    await expect(recognitionChoice.getByRole("option", { name: "On this Mac, once set up above" })).toHaveJSProperty("disabled", true);
    expect(await dictate(page, conversationId)).toEqual({ status: 409, body: "Voice isn't set up on this Mac yet. Settings → Voice can set it up." });
  });
});
