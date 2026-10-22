import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspace, callCanvasTool, openSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

const SPEECH_SECONDS = 2;
const SILENCE_SECONDS = 4;

/** Speech-like bursts, then silence: Chrome's fake microphone plays it from the start each time it opens, then over again. */
function microphoneSound() {
  const rate = 48_000;
  const samples = Array.from({ length: (SPEECH_SECONDS + SILENCE_SECONDS) * rate }, (_, index) => {
    const seconds = index / rate;
    if (seconds >= SPEECH_SECONDS) return 0;
    const syllables = Math.sqrt(Math.max(0, Math.sin(2 * Math.PI * 4 * seconds)));
    const pitch = 140 + 30 * Math.sin(2 * Math.PI * 1.3 * seconds);
    const harmonics = Array.from({ length: 12 }, (_, overtone) => Math.sin(2 * Math.PI * pitch * (overtone + 1) * seconds) / (overtone + 1));
    return 0.25 * syllables * harmonics.reduce((sum, harmonic) => sum + harmonic, 0);
  });
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + index * 2));
  return wav;
}

/** Each Playwright process loads the spec, and runs of other checkouts may too, so the file is put in place whole, named by its sound. */
const sound = microphoneSound();
const microphoneFile = join(tmpdir(), `mirador-e2e-dictation-microphone-${createHash("sha256").update(sound).digest("hex").slice(0, 12)}.wav`);
if (!existsSync(microphoneFile)) {
  const partial = `${microphoneFile}.${process.pid}`;
  writeFileSync(partial, sound);
  renameSync(partial, microphoneFile);
}

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${microphoneFile}`] },
  permissions: ["microphone"],
});

const HEARD_IN_HUNGARIAN = "Futtasd le az e2e teszteket.";
const IN_ENGLISH = "Run the e2e tests.";

interface Clip {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  seconds: number;
}

let clips: Clip[] = [];
let failing = false;

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function clipIn(body: Buffer, contentType: string): Promise<Clip> {
  const form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  const wav = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
  const sampleRate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const bitsPerSample = wav.readUInt16LE(34);
  return { sampleRate, channels, bitsPerSample, seconds: wav.readUInt32LE(40) / (sampleRate * channels * (bitsPerSample / 8)) };
}

/** Answers as an OpenAI-style speech recognition and chat server would, noting each clip it hears. */
const voiceServer = createServer(async (request, response) => {
  const body = await bodyOf(request);
  if (request.url?.endsWith("/audio/transcriptions")) {
    clips.push(await clipIn(body, request.headers["content-type"] ?? ""));
    if (failing) return response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "The model isn't loaded." } }));
    response.setHeader("content-type", "application/json");
    return response.end(JSON.stringify({ text: HEARD_IN_HUNGARIAN, language: "hu" }));
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: IN_ENGLISH } }] }));
});
const voiceServerUrl = () => `http://127.0.0.1:${(voiceServer.address() as AddressInfo).port}/v1`;

const host = new TestHost();

test.beforeAll(async () => {
  await new Promise<void>((resolve) => voiceServer.listen(0, "127.0.0.1", resolve));
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  voiceServer.close();
});

async function useOwnServer(service: Locator, choice: string, model: string) {
  await service.getByLabel(choice).selectOption({ label: "With a server of your own" });
  await service.getByLabel("Address").fill(voiceServerUrl());
  await service.getByLabel("Model").fill(model);
}

async function saveVoiceSettings(page: Page, change: (settings: Locator) => Promise<void>) {
  const settings = await openSettings(page, "Voice");
  await change(settings);
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("status")).toHaveText("Saved.");
  await settings.getByRole("button", { name: "Close" }).click();
}

const dictateKey = (page: Page) => page.evaluate(() => (navigator.userAgent.includes("Mac") ? "Meta" : "Control"));

test("The mic button and ⌘⇧Space dictate into the message box: a tap listens until a pause, a hold until let go, and the English goes in at the caret with what was said under it", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);
  const box = page.locator(".composer:visible textarea");
  const mic = page.locator(".composer:visible").getByRole("button", { name: "Dictate" });
  const problem = page.locator(".composer-area:visible .composer-problem");
  const status = page.locator(".composer-area:visible .dictation-status");
  const original = page.locator(".composer-area:visible .dictation-original");
  const primary = await dictateKey(page);

  await test.step("with speech recognition off, the mic is greyed out, and pressing it or its key says where to turn it on", async () => {
    await expect(mic).toHaveAttribute("aria-disabled", "true");
    await mic.click({ force: true });
    await expect(problem).toHaveText("Dictating needs speech recognition. Settings → Voice can turn it on.");
    await page.reload();
    await box.focus();
    await page.keyboard.press(`${primary}+Shift+Space`);
    await expect(problem).toHaveText("Dictating needs speech recognition. Settings → Voice can turn it on.");
    expect(clips).toEqual([]);
  });

  await saveVoiceSettings(page, async (settings) => {
    await useOwnServer(settings.getByRole("group", { name: "Speech recognition" }), "Turns speech into text", "whisper-turbo");
    await useOwnServer(settings.getByRole("group", { name: "Voice model" }), "Translates", "gemma");
    await settings.getByLabel("You speak").selectOption({ label: "Hungarian" });
  });

  await test.step("a tap listens until the user pauses, then the English goes in at the caret, in 16 kHz mono WAV to the server, with what was said under the box", async () => {
    await expect(mic).not.toHaveAttribute("aria-disabled");
    await box.fill("Please now");
    await box.evaluate((textarea: HTMLTextAreaElement) => textarea.setSelectionRange(7, 7));
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await expect(status).toHaveText("Listening… It stops when you pause or let go. Esc cancels.");
    await expect(box).toHaveValue(`Please ${IN_ENGLISH} now`, { timeout: 15_000 });
    await expect(mic).toHaveAttribute("aria-pressed", "false");
    await expect(status).toHaveCount(0);
    await expect(original).toContainText(`You said: ${HEARD_IN_HUNGARIAN}`);
    await expect(problem).toHaveCount(0);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
    expect(clips[0]!.seconds, "it stopped at the pause after the speech, before the sound came round again").toBeGreaterThan(SPEECH_SECONDS + 1);
    expect(clips[0]!.seconds).toBeLessThan(SPEECH_SECONDS + SILENCE_SECONDS);
  });

  await test.step("holding the key listens through pauses until it is let go, and what was said adds up under the box", async () => {
    await box.focus();
    await box.press("End");
    await page.keyboard.down(primary);
    await page.keyboard.down("Shift");
    await page.keyboard.down("Space");
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout((SPEECH_SECONDS + 3.5) * 1_000);
    await expect(mic, "a hold doesn't stop at a pause").toHaveAttribute("aria-pressed", "true");
    await page.keyboard.up("Space");
    await page.keyboard.up("Shift");
    await page.keyboard.up(primary);
    await expect(box).toHaveValue(`Please ${IN_ENGLISH} now ${IN_ENGLISH}`, { timeout: 15_000 });
    expect(clips.at(-1)!.seconds).toBeGreaterThan(SPEECH_SECONDS + 3);
    await expect(original).toContainText(`You said: ${HEARD_IN_HUNGARIAN} ${HEARD_IN_HUNGARIAN}`);
  });

  await test.step("Esc cancels listening without sending anything, and clearing the box hides what was said", async () => {
    const heardBefore = clips.length;
    await mic.click();
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(mic).toHaveAttribute("aria-pressed", "false");
    await expect(status).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(clips).toHaveLength(heardBefore);
    await box.fill("");
    await expect(original).toHaveCount(0);
  });

  await test.step("when the server fails, the message box says why", async () => {
    failing = true;
    await mic.click();
    await expect(problem).toContainText("The speech recognition server answered 500", { timeout: 15_000 });
    await expect(box).toHaveValue("");
    failing = false;
  });

  await test.step("the key taps from a focused canvas page too, and what was said goes into the message box", async () => {
    await callCanvasTool(host, conversationId, "show", { title: "Page", html: "<p>canvas page</p>" });
    const canvasPage = page.locator(".canvas-frame.show iframe");
    await expect(page.frameLocator(".canvas-frame.show iframe").getByText("canvas page")).toBeVisible();
    await canvasPage.focus();
    await page.keyboard.press(`${primary}+Shift+Space`);
    await expect(mic).toHaveAttribute("aria-pressed", "true");
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(IN_ENGLISH, { timeout: 15_000 });
    await box.fill("");
  });

  await saveVoiceSettings(page, (settings) => settings.getByLabel("Send right away").check());

  await test.step("with Send right away, what was said is sent once it is text", async () => {
    await mic.click();
    await expect(page.locator(".timeline:visible .message.user").filter({ hasText: IN_ENGLISH })).toHaveCount(1, { timeout: 15_000 });
    await expect(box).toHaveValue("");
    await expect(problem).toHaveCount(0);
  });
});
