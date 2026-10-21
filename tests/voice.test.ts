import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Profile } from "../shared/model.ts";
import { defaultVoiceSettings, voiceSettingsProblem, voiceSettingsWithoutKeys, type VoiceSettings } from "../shared/voice.ts";
import { Store } from "../host/store.ts";
import { Voice, VoiceUnavailable, type ThisMac } from "../host/voice/voice.ts";

interface Heard {
  path: string;
  authorization: string | null;
  apiKey: string | null;
  form: Record<string, string> | null;
  json: Record<string, unknown> | null;
}

const described = (value: unknown) => (value instanceof Blob ? `${value.size} bytes` : String(value));

let heard: Heard[] = [];
let transcript: { text: string; language?: string } = { text: "" };
let translation = "";
let failure: { status: number; text: string } | null = null;
let chatChoice: Record<string, unknown> | null = null;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const form = path.endsWith("/audio/transcriptions") ? await request.formData() : null;
    const formFields = form && Object.fromEntries([...form.entries()].map(([name, value]) => [name, described(value)]));
    const json = form ? null : ((await request.json()) as Record<string, unknown>);
    heard.push({ path, authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-api-key"), form: formFields, json });
    if (failure) return new Response(failure.text, { status: failure.status });
    if (path.endsWith("/audio/transcriptions")) return Response.json(transcript);
    if (path.endsWith("/chat/completions")) {
      return Response.json({ choices: [chatChoice ?? { message: { role: "assistant", content: `<message>${translation}</message>` }, finish_reason: "stop" }] });
    }
    return Response.json({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: json?.model,
      content: [{ type: "text", text: translation }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  heard = [];
  failure = null;
  chatChoice = null;
});

const origin = `http://127.0.0.1:${server.port}`;
const clip = new Blob([new Uint8Array(44)], { type: "audio/wav" });
const ownVoiceModel = { kind: "custom", endpoint: { url: `${origin}/v1`, apiKey: "model-key", model: "gemma" }, turnsThinkingOff: false } as const;
const ownServers: VoiceSettings = {
  ...defaultVoiceSettings,
  recognition: { kind: "custom", endpoint: { url: `${origin}/v1/`, apiKey: "speech-key", model: "whisper-turbo" } },
  voiceModel: ownVoiceModel,
  language: "hu",
};
const profile = (environment: string): Profile => ({
  id: "p1",
  name: "work",
  harness: "claude",
  environment,
  prelaunch: "",
  mode: null,
  bypassPermissions: false,
  askMode: "wait",
  color: null,
  createdAt: 1,
});
const voiceWith = (settings: VoiceSettings, profiles: Profile[] = []) => new Voice(() => settings, (id) => profiles.find((each) => each.id === id));

describe("dictation", () => {
  test("a Hungarian clip comes back in English, with what was heard under it, through servers of the user's own", async () => {
    transcript = { text: "Futtasd le az e2e teszteket.", language: "hu" };
    translation = "Run the e2e tests.";
    expect(await voiceWith(ownServers).dictation(clip)).toEqual({ text: "Run the e2e tests.", original: "Futtasd le az e2e teszteket.", language: "hu" });
    const [recognition, voiceModel] = heard;
    expect(recognition).toMatchObject({ path: "/v1/audio/transcriptions", authorization: "Bearer speech-key" });
    expect(recognition!.form).toEqual({ file: "44 bytes", model: "whisper-turbo", response_format: "json", language: "hu" });
    expect(voiceModel).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer model-key" });
    expect(voiceModel!.json).toMatchObject({ model: "gemma", temperature: 0, max_completion_tokens: 16_000 });
    expect(voiceModel!.json).not.toHaveProperty("chat_template_kwargs");
    expect(JSON.stringify(voiceModel!.json)).toContain("<message>Futtasd le az e2e teszteket.</message>");
  });

  test("English speech, or translation turned off, goes into the box as heard, without asking the voice model", async () => {
    transcript = { text: "Run the e2e tests.", language: "en" };
    expect(await voiceWith({ ...ownServers, language: "auto" }).dictation(clip)).toEqual({ text: "Run the e2e tests.", original: null, language: "en" });
    expect(heard[0]!.form).not.toHaveProperty("language");

    transcript = { text: "Futtasd le az e2e teszteket.", language: "hu" };
    expect(await voiceWith({ ...ownServers, translateToEnglish: false }).dictation(clip)).toMatchObject({ text: "Futtasd le az e2e teszteket.", original: null });
    expect(heard.map(({ path }) => path)).toEqual(["/v1/audio/transcriptions", "/v1/audio/transcriptions"]);
  });

  test("when the server doesn't say what it heard, the voice model decides, and English it leaves alone stays as heard", async () => {
    transcript = { text: "Run the e2e tests." };
    translation = "Run the e2e tests.";
    expect(await voiceWith({ ...ownServers, language: "auto" }).dictation(clip)).toEqual({ text: "Run the e2e tests.", original: null, language: null });
    expect(heard).toHaveLength(2);
  });

  test("with the voice model off, what was heard goes into the box untranslated", async () => {
    transcript = { text: "Futtasd le az e2e teszteket.", language: "hu" };
    expect(await voiceWith({ ...ownServers, voiceModel: { kind: "off" } }).dictation(clip)).toMatchObject({ original: null, text: "Futtasd le az e2e teszteket." });
  });

  test("a profile lends the voice model its Anthropic address and token, and its agent's own keys stay out", async () => {
    transcript = { text: "Futtasd le az e2e teszteket.", language: "hu" };
    translation = "Run the e2e tests.";
    const settings: VoiceSettings = { ...ownServers, voiceModel: { kind: "profile", profileId: "p1", model: "claude-opus-5-5" } };
    const environment = `ANTHROPIC_BASE_URL=${origin}\nANTHROPIC_AUTH_TOKEN=profile-token\n-u ANTHROPIC_API_KEY`;
    expect(await voiceWith(settings, [profile(environment)]).dictation(clip)).toMatchObject({ text: "Run the e2e tests." });
    expect(heard[1]).toMatchObject({ path: "/v1/messages", authorization: "Bearer profile-token", apiKey: null });
    expect(heard[1]!.json).toMatchObject({ model: "claude-opus-5-5" });
  });

  test("a profile may lend an OpenAI key and address instead", async () => {
    transcript = { text: "Futtasd le az e2e teszteket.", language: "hu" };
    translation = "Run the e2e tests.";
    const settings: VoiceSettings = { ...ownServers, voiceModel: { kind: "profile", profileId: "p1", model: "gpt-5" } };
    const environment = `OPENAI_BASE_URL=${origin}/v1\nOPENAI_API_KEY=openai-key\n-u ANTHROPIC_API_KEY\n-u ANTHROPIC_AUTH_TOKEN`;
    expect(await voiceWith(settings, [profile(environment)]).dictation(clip)).toMatchObject({ text: "Run the e2e tests." });
    expect(heard[1]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer openai-key" });
  });

  test("voice off, this Mac's engine before it is set up, and a profile without a key each say what to change", async () => {
    transcript = { text: "Futtasd le.", language: "hu" };
    await expect(voiceWith(defaultVoiceSettings).dictation(clip)).rejects.toThrow(new VoiceUnavailable("Voice is off. Settings → Voice can turn it on."));
    await expect(voiceWith({ ...ownServers, recognition: { kind: "this-mac" } }).dictation(clip)).rejects.toBeInstanceOf(VoiceUnavailable);
    const keyless = profile("-u ANTHROPIC_API_KEY\n-u ANTHROPIC_AUTH_TOKEN\n-u OPENAI_API_KEY");
    const settings: VoiceSettings = { ...ownServers, voiceModel: { kind: "profile", profileId: "p1", model: "claude-opus-5-5" } };
    await expect(voiceWith(settings, [keyless]).dictation(clip)).rejects.toThrow("The profile work has no ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY");
  });

  test("a voice model of the user's own that thinks first is asked not to, and one that thinks out its room says what to change", async () => {
    transcript = { text: "Futtasd le az e2e teszteket.", language: "hu" };
    translation = "Run the e2e tests.";
    expect(await voiceWith({ ...ownServers, voiceModel: { ...ownVoiceModel, turnsThinkingOff: true } }).dictation(clip)).toMatchObject({ text: "Run the e2e tests." });
    expect(heard[1]!.json).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });

    chatChoice = { message: { role: "assistant", content: null, reasoning: "Source language: Hungarian…" }, finish_reason: "length" };
    await expect(voiceWith(ownServers).dictation(clip)).rejects.toThrow("The voice model ran out of room before it answered. If it thinks first, Settings → Voice can ask it not to.");
    const environment = `OPENAI_BASE_URL=${origin}/v1\nOPENAI_API_KEY=openai-key\n-u ANTHROPIC_API_KEY\n-u ANTHROPIC_AUTH_TOKEN`;
    const throughProfile: VoiceSettings = { ...ownServers, voiceModel: { kind: "profile", profileId: "p1", model: "gpt-5" } };
    await expect(voiceWith(throughProfile, [profile(environment)]).dictation(clip), "a profile's API has no such switch").rejects.toThrow(
      new Error("The voice model ran out of room before it answered."),
    );
  });

  test("this Mac's engine asks its speech server for the language it heard, and its voice model not to think first", async () => {
    transcript = { text: "Futtasd le az e2e teszteket.", language: "hu" };
    translation = "Run the e2e tests.";
    const lent: string[] = [];
    const thisMac: ThisMac = (service, work) => {
      lent.push(service);
      return work({ url: `${origin}/v1`, apiKey: "", model: `/voice/models/${service}` });
    };
    const settings: VoiceSettings = { ...defaultVoiceSettings, recognition: { kind: "this-mac" }, voiceModel: { kind: "this-mac" } };
    expect(await new Voice(() => settings, () => undefined, thisMac).dictation(clip)).toEqual({ text: "Run the e2e tests.", original: "Futtasd le az e2e teszteket.", language: "hu" });
    expect(lent).toEqual(["recognition", "voiceModel"]);
    expect(heard[0]!.form).toEqual({ file: "44 bytes", model: "/voice/models/recognition", response_format: "verbose_json" });
    expect(heard[1]!.json).toMatchObject({ model: "/voice/models/voiceModel", chat_template_kwargs: { enable_thinking: false } });
  });

  test("a server's error comes back with its status and what it said", async () => {
    failure = { status: 500, text: "model not loaded" };
    await expect(voiceWith(ownServers).dictation(clip)).rejects.toThrow("The speech recognition server answered 500: model not loaded");
  });
});

describe("voice settings", () => {
  test("endpoints need an http address and a model, and the language a code", () => {
    expect(voiceSettingsProblem(ownServers)).toBeNull();
    const withRecognition = (url: string, model = "whisper"): VoiceSettings => ({ ...ownServers, recognition: { kind: "custom", endpoint: { url, apiKey: "", model } } });
    expect(voiceSettingsProblem(withRecognition("ftp://box/v1"))).toBe("The speech recognition address must be an http or https URL.");
    expect(voiceSettingsProblem(withRecognition("http://box/v1", " "))).toBe("The speech recognition needs a model name.");
    expect(voiceSettingsProblem({ ...ownServers, voiceModel: { kind: "profile", profileId: "p1", model: "" } })).toBe("The voice model needs a model name.");
    expect(voiceSettingsProblem({ ...ownServers, language: "Hungarian" })).toBe("Hungarian is not a language code.");
    expect(voiceSettingsProblem({ ...ownServers, recognition: { kind: "profile" } as unknown as VoiceSettings["recognition"] })).toContain("Speech recognition is off");
  });

  test("this Mac's engine unloads after a whole number of minutes, up to a day", () => {
    expect(voiceSettingsProblem({ ...ownServers, engineIdleMinutes: 1_440 })).toBeNull();
    [0, 1_441, 2.5, Number.NaN].forEach((engineIdleMinutes) =>
      expect(voiceSettingsProblem({ ...ownServers, engineIdleMinutes })).toBe("Unloading takes a whole number of minutes from 1 to 1440."),
    );
  });

  test("clients that never get profile environments don't get the endpoints' keys either", () => {
    const withoutKeys = voiceSettingsWithoutKeys(ownServers);
    expect(withoutKeys.recognition).toEqual({ kind: "custom", endpoint: { url: `${origin}/v1/`, apiKey: "", model: "whisper-turbo" } });
    expect(withoutKeys.voiceModel).toEqual({ kind: "custom", endpoint: { url: `${origin}/v1`, apiKey: "", model: "gemma" }, turnsThinkingOff: false });
  });

  test("the host keeps them, starting with voice off", () => {
    const store = new Store(":memory:");
    expect(store.voiceSettings()).toEqual(defaultVoiceSettings);
    store.setVoiceSettings(ownServers);
    expect(store.voiceSettings()).toEqual(ownServers);
    const { engineIdleMinutes: _, ...savedBeforeTheIdleTime } = ownServers;
    store.setVoiceSettings(savedBeforeTheIdleTime as VoiceSettings);
    expect(store.voiceSettings().engineIdleMinutes).toBe(30);
  });
});
