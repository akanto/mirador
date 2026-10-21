import { expect, test, type Locator, type Page } from "@playwright/test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { addWorkspace, openSettings, signIn, startConversation } from "./helpers.ts";
import { TestHost } from "./test-host.ts";

interface Heard {
  path: string;
  authorization: string | undefined;
  form: Record<string, string> | null;
  json: { model?: string; messages?: unknown[] } | null;
}

const HEARD_IN_HUNGARIAN = "Futtasd le az e2e teszteket.";
const IN_ENGLISH = "Run the e2e tests.";

const host = new TestHost();
let heard: Heard[] = [];

async function bodyOf(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const described = (value: unknown) => (value instanceof Blob ? `${value.size} bytes` : String(value));

async function formOf(body: Buffer, contentType: string) {
  const form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  return Object.fromEntries([...form.entries()].map(([name, value]) => [name, described(value)]));
}

/** Answers as an OpenAI-style speech recognition and chat server would. */
const voiceServer = createServer(async (request, response) => {
  const path = request.url ?? "";
  const body = await bodyOf(request);
  const transcribing = path.endsWith("/audio/transcriptions");
  const form = transcribing ? await formOf(body, request.headers["content-type"] ?? "") : null;
  heard.push({ path, authorization: request.headers.authorization, form, json: transcribing ? null : JSON.parse(body.toString()) });
  response.setHeader("content-type", "application/json");
  const answer = transcribing ? { text: HEARD_IN_HUNGARIAN, language: "hu" } : { choices: [{ message: { role: "assistant", content: IN_ENGLISH } }] };
  response.end(JSON.stringify(answer));
});
const voiceServerUrl = () => `http://127.0.0.1:${(voiceServer.address() as AddressInfo).port}/v1`;

test.beforeAll(async () => {
  await new Promise<void>((resolve) => voiceServer.listen(0, "127.0.0.1", resolve));
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
  voiceServer.close();
});

/** What the composer will send: a clip of 16 kHz mono WAV, here a header without samples. */
async function dictate(page: Page, conversationId: string) {
  return page.evaluate(async (conversationId) => {
    const response = await fetch(`/conversations/${conversationId}/speech`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: new Uint8Array(44) });
    return { status: response.status, body: await response.text() };
  }, conversationId);
}

async function useOwnServer(service: Locator, choice: string, { apiKey, model }: { apiKey: string; model: string }) {
  await service.getByLabel(choice).selectOption({ label: "With a server of your own" });
  await service.getByLabel("Address").fill(voiceServerUrl());
  await service.getByLabel("API key").fill(apiKey);
  await service.getByLabel("Model").fill(model);
}

test("Settings → Voice set the user's own servers, and a Hungarian clip comes back in English with what was heard", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const conversationId = await startConversation(page);

  await test.step("with voice off, a clip says where to turn it on", async () => {
    expect(await dictate(page, conversationId)).toEqual({ status: 409, body: "Voice is off. Settings → Voice can turn it on." });
  });

  const settings = await openSettings(page, "Voice");
  const recognition = settings.getByRole("group", { name: "Speech recognition" });
  const voiceModel = settings.getByRole("group", { name: "Voice model" });

  await test.step("an address that isn't http isn't saved", async () => {
    await useOwnServer(recognition, "Turns speech into text", { apiKey: "speech-key", model: "whisper-turbo" });
    await recognition.getByLabel("Address").fill("ftp://box/v1");
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("status")).toHaveText("The speech recognition address must be an http or https URL.");
  });

  await test.step("both servers and the language save together, and another window shows them", async () => {
    await recognition.getByLabel("Address").fill(voiceServerUrl());
    await expect(settings.getByRole("status")).toBeEmpty();
    await useOwnServer(voiceModel, "Translates", { apiKey: "model-key", model: "gemma" });
    await settings.getByLabel("You speak").selectOption({ label: "Hungarian" });
    await expect(settings.getByLabel("Translate into English")).toBeChecked();
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("status")).toHaveText("Saved.");
    await expect(settings.getByRole("button", { name: "Save" })).toBeDisabled();

    const otherWindow = await page.context().newPage();
    await otherWindow.goto(page.url());
    const otherSettings = await openSettings(otherWindow, "Voice");
    await expect(otherSettings.getByRole("group", { name: "Speech recognition" }).getByLabel("Model")).toHaveValue("whisper-turbo");
    await expect(otherSettings.getByRole("group", { name: "Voice model" }).getByLabel("Address")).toHaveValue(voiceServerUrl());
    await expect(otherSettings.getByLabel("You speak")).toHaveValue("hu");
    await otherWindow.close();
  });

  await test.step("a clip goes to the recognizer in Hungarian, then to the voice model, and comes back in English", async () => {
    heard = [];
    const { status, body } = await dictate(page, conversationId);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ text: IN_ENGLISH, original: HEARD_IN_HUNGARIAN, language: "hu" });
    const [transcription, translation] = heard;
    expect(transcription).toMatchObject({ path: "/v1/audio/transcriptions", authorization: "Bearer speech-key" });
    expect(transcription!.form).toEqual({ file: "44 bytes", model: "whisper-turbo", response_format: "json", language: "hu" });
    expect(translation).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer model-key", json: { model: "gemma" } });
    expect(JSON.stringify(translation!.json!.messages)).toContain(HEARD_IN_HUNGARIAN);
  });

  await test.step("with translation off, what was heard comes back as it is", async () => {
    await settings.getByLabel("Translate into English").uncheck();
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByRole("status")).toHaveText("Saved.");
    expect(JSON.parse((await dictate(page, conversationId)).body)).toEqual({ text: HEARD_IN_HUNGARIAN, original: null, language: "hu" });
  });
});
