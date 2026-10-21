import Anthropic from "@anthropic-ai/sdk";
import type { CustomEndpoint } from "../../shared/voice.ts";

export interface Transcript {
  text: string;
  /** The language heard, when the server tells: OpenAI's own speech models don't. */
  language: string | null;
}

/** An OpenAI-style chat server, or Anthropic's messages API as a profile names it. */
export type ChatEndpoint =
  /** adviceWhenTooLong is what the user can change when the model takes too long to answer, as a sentence. */
  | (CustomEndpoint & { api: "openai"; turnsThinkingOff: boolean; adviceWhenTooLong?: string })
  | { api: "anthropic"; baseUrl: string; apiKey: string | null; authToken: string | null; model: string };

/** A local model may first have to load, which takes a while. */
const ENDPOINT_TIMEOUT_MS = 120_000;
const MAX_REPLY_TOKENS = 16_000;

const joined = (url: string, path: string) => `${url.replace(/\/+$/, "")}${path}`;
const bearer = (apiKey: string): Record<string, string> => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
const withAdvice = (problem: string, advice = "") => (advice ? `${problem} ${advice}` : problem);

async function postTo(service: string, url: string, request: { headers: Record<string, string>; body: BodyInit }, adviceWhenTooLong?: string) {
  try {
    return await fetch(url, { method: "POST", ...request, signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(withAdvice(`The ${service} didn't answer within ${ENDPOINT_TIMEOUT_MS / 60_000} minutes.`, adviceWhenTooLong));
    }
    throw error;
  }
}

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
  const response = await postTo("speech recognition server", joined(endpoint.url, "/audio/transcriptions"), { headers: bearer(endpoint.apiKey), body: form });
  const answer = (await answerOf(response, "speech recognition server")) as { text?: unknown; language?: unknown };
  if (typeof answer.text !== "string") throw new Error("The speech recognition server answered without text.");
  return { text: answer.text.trim(), language: typeof answer.language === "string" && answer.language ? answer.language : null };
}

async function completeWithOpenAi(endpoint: Extract<ChatEndpoint, { api: "openai" }>, instructions: string, text: string) {
  const response = await postTo("voice model", joined(endpoint.url, "/chat/completions"), {
    headers: { "Content-Type": "application/json", ...bearer(endpoint.apiKey) },
    body: JSON.stringify({
      model: endpoint.model,
      temperature: 0,
      max_completion_tokens: MAX_REPLY_TOKENS,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: text },
      ],
      ...(endpoint.turnsThinkingOff && { chat_template_kwargs: { enable_thinking: false } }),
    }),
  }, endpoint.adviceWhenTooLong);
  const answer = (await answerOf(response, "voice model")) as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] };
  const [choice] = answer.choices ?? [];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (choice?.finish_reason === "length") throw new Error(withAdvice("The voice model ran out of room before it answered.", endpoint.adviceWhenTooLong));
  throw new Error("The voice model answered without text.");
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
