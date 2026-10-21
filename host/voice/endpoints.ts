import Anthropic from "@anthropic-ai/sdk";
import type { CustomEndpoint } from "../../shared/voice.ts";

export interface Transcript {
  text: string;
  /** The language heard, when the server tells: OpenAI's own speech models don't. */
  language: string | null;
}

/** An OpenAI-style chat server, or Anthropic's messages API as a profile names it. */
export type ChatEndpoint =
  | (CustomEndpoint & { api: "openai"; turnsThinkingOff: boolean })
  | { api: "anthropic"; baseUrl: string; apiKey: string | null; authToken: string | null; model: string };

/** A local model may first have to load, which takes a while. */
const ENDPOINT_TIMEOUT_MS = 120_000;
const MAX_REPLY_TOKENS = 16_000;

const joined = (url: string, path: string) => `${url.replace(/\/+$/, "")}${path}`;
const bearer = (apiKey: string): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

async function answerOf(response: Response, service: string) {
  if (response.ok) return response.json() as Promise<unknown>;
  const detail = (await response.text()).trim().slice(0, 300);
  throw new Error(`The ${service} answered ${response.status}${detail ? `: ${detail}` : ""}`);
}

export async function transcribe(endpoint: CustomEndpoint, clip: Blob, language: string | null): Promise<Transcript> {
  const form = new FormData();
  form.append("file", clip, "speech.wav");
  form.append("model", endpoint.model);
  form.append("response_format", "json");
  if (language) form.append("language", language);
  const response = await fetch(joined(endpoint.url, "/audio/transcriptions"), {
    method: "POST",
    headers: bearer(endpoint.apiKey),
    body: form,
    signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
  });
  const answer = (await answerOf(response, "speech recognition server")) as { text?: unknown; language?: unknown };
  if (typeof answer.text !== "string") throw new Error("The speech recognition server answered without text.");
  return { text: answer.text.trim(), language: typeof answer.language === "string" && answer.language ? answer.language : null };
}

async function completeWithOpenAi(endpoint: Extract<ChatEndpoint, { api: "openai" }>, instructions: string, text: string) {
  const response = await fetch(joined(endpoint.url, "/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(endpoint.apiKey) },
    body: JSON.stringify({
      model: endpoint.model,
      temperature: 0,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: text },
      ],
      ...(endpoint.turnsThinkingOff && { chat_template_kwargs: { enable_thinking: false } }),
    }),
    signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
  });
  const answer = (await answerOf(response, "voice model")) as { choices?: { message?: { content?: unknown } }[] };
  const content = answer.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("The voice model answered without text.");
  return content;
}

async function completeWithAnthropic(endpoint: Extract<ChatEndpoint, { api: "anthropic" }>, instructions: string, text: string) {
  const client = new Anthropic({ baseURL: endpoint.baseUrl, apiKey: endpoint.apiKey, authToken: endpoint.authToken, timeout: ENDPOINT_TIMEOUT_MS });
  const message = await client.messages.create({
    model: endpoint.model,
    max_tokens: MAX_REPLY_TOKENS,
    system: instructions,
    messages: [{ role: "user", content: text }],
  });
  if (message.stop_reason === "refusal") throw new Error("The voice model declined to answer.");
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

export async function complete(endpoint: ChatEndpoint, instructions: string, text: string) {
  const answer = endpoint.api === "openai" ? await completeWithOpenAi(endpoint, instructions, text) : await completeWithAnthropic(endpoint, instructions, text);
  return answer.trim();
}
