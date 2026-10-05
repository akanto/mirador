import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { resolveModelPreference } from "@agentclientprotocol/claude-agent-acp/dist/session-model.js";
import { flatSelectOptions } from "../shared/config-options.ts";

/** Claude Code records an API error as an answer from a made-up model such as "<synthetic>". */
const isRealModel = (model: unknown): model is string => typeof model === "string" && model.trim() !== "" && !/^<[^>]+>$/.test(model.trim());

function answeringModel(line: string): string | null {
  try {
    const record = JSON.parse(line);
    return record?.type === "assistant" && !record.isSidechain && isRealModel(record.message?.model) ? record.message.model : null;
  } catch {
    return null;
  }
}

/** The model that last answered in a Claude Code transcript's main thread, which Claude Code resumes the session on. */
export function lastAnsweringModel(transcript: string): string | null {
  const answer = transcript.split("\n").findLast((line) => answeringModel(line) !== null);
  return answer === undefined ? null : answeringModel(answer);
}

/** The model picker's choice for a model a transcript names, matched the way claude-agent-acp matches one. */
export function modelChoiceFor(configOptions: SessionConfigOption[], model: string): string | null {
  const picker = configOptions.find((option) => option.category === "model" && option.type === "select");
  if (picker?.type !== "select") return null;
  const choices = flatSelectOptions(picker).map(({ value, name, description }) => ({ value, displayName: name, description: description ?? "" }));
  return resolveModelPreference(choices, model)?.value ?? null;
}
