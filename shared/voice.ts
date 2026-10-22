import { choosableModel, FIRST_MODELS, type ThisMacService } from "./voice-engine-models.ts";

/** An OpenAI-style server of the user's own: another local server, one on another machine, or a hosted API. */
export interface CustomEndpoint {
  /** Up to and including the API version, as in https://api.openai.com/v1. */
  url: string;
  apiKey: string;
  model: string;
}

type Off = { kind: "off" };
/** model is one of this Mac's engine's, by id. */
type ThisMac = { kind: "this-mac"; model: string };
type OwnServer = { kind: "custom"; endpoint: CustomEndpoint };

export type VoiceSource = Off | ThisMac | OwnServer;

/** A profile lends the API its environment names, Anthropic's or OpenAI's, without starting its agent. */
export type VoiceModelSource =
  | Off
  | ThisMac
  /** turnsThinkingOff asks a local server not to think first, which OpenAI's API refuses. */
  | (OwnServer & { turnsThinkingOff: boolean })
  | { kind: "profile"; profileId: string; model: string };

export interface VoiceSettings {
  /** Turns speech into text in the language spoken. */
  recognition: VoiceSource;
  /** Translates what the user says and writes, and sums up replies to be spoken. */
  voiceModel: VoiceModelSource;
  /** What the user speaks, as a language code such as "hu", or "auto" for the recognizer to tell. */
  language: string;
  translateToEnglish: boolean;
  sendRightAway: boolean;
  /** How long this Mac's engine keeps a server loaded once unused; loading it again takes a while. */
  engineIdleMinutes: number;
}

export const AUTO_LANGUAGE = "auto";

export const defaultVoiceSettings: VoiceSettings = {
  recognition: { kind: "off" },
  voiceModel: { kind: "off" },
  language: AUTO_LANGUAGE,
  translateToEnglish: true,
  sendRightAway: false,
  engineIdleMinutes: 30,
};

const primaryLanguage = (language: string) => language.toLowerCase().split(/[-_]/)[0];
export const isEnglish = (language: string) => primaryLanguage(language) === "en";
export const sameLanguage = (one: string, other: string) => primaryLanguage(one) === primaryLanguage(other);

/** A dictated clip as the host turns it into text for the message box. */
export interface Dictation {
  /** What goes into the message box: the English when it was translated, else what was heard. */
  text: string;
  /** What was heard, when the text is its translation. */
  original: string | null;
  /** The language heard, when the recognizer tells or the user chose one. */
  language: string | null;
}

const MAX_IDLE_MINUTES = 24 * 60;
const LANGUAGE_CODE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

function endpointProblem(service: string, { url, model }: CustomEndpoint) {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return `The ${service} address must be an http or https URL.`;
  if (model.trim() === "") return `The ${service} needs a model name.`;
  return null;
}

const thisMacModelsName: Record<ThisMacService, string> = { recognition: "speech recognition models", voiceModel: "voice models" };

function sourceProblem(service: string, source: VoiceSource | VoiceModelSource, thisMacService: ThisMacService) {
  if (source.kind === "custom") return endpointProblem(service, source.endpoint);
  if (source.kind === "this-mac" && choosableModel(source.model)?.service !== thisMacService) return `Choose one of this Mac's ${thisMacModelsName[thisMacService]}.`;
  if (source.kind === "profile" && source.model.trim() === "") return `The ${service} needs a model name.`;
  return null;
}

const sourceKinds: VoiceSource["kind"][] = ["off", "this-mac", "custom"];
const voiceModelKinds: VoiceModelSource["kind"][] = [...sourceKinds, "profile"];

export function voiceSettingsProblem(settings: VoiceSettings) {
  if (!sourceKinds.includes(settings.recognition.kind)) return "Speech recognition is off, this Mac's or a server of your own.";
  if (!voiceModelKinds.includes(settings.voiceModel.kind)) return "The voice model is off, this Mac's, a server of your own or a profile's.";
  if (settings.language !== AUTO_LANGUAGE && !LANGUAGE_CODE.test(settings.language)) return `${settings.language} is not a language code.`;
  if (!Number.isInteger(settings.engineIdleMinutes) || settings.engineIdleMinutes < 1 || settings.engineIdleMinutes > MAX_IDLE_MINUTES) {
    return `Unloading takes a whole number of minutes from 1 to ${MAX_IDLE_MINUTES}.`;
  }
  return sourceProblem("speech recognition", settings.recognition, "recognition") ?? sourceProblem("voice model", settings.voiceModel, "voiceModel");
}

const withFirstModel = <Source extends VoiceSource | VoiceModelSource>(source: Source, service: ThisMacService): Source =>
  source.kind === "this-mac" && !source.model ? { ...source, model: FIRST_MODELS[service] } : source;

/** Settings saved before this Mac's models could be chosen used the first ones. */
export const withThisMacModels = (settings: VoiceSettings): VoiceSettings => ({
  ...settings,
  recognition: withFirstModel(settings.recognition, "recognition"),
  voiceModel: withFirstModel(settings.voiceModel, "voiceModel"),
});

export const thisMacModelsInUse = ({ recognition, voiceModel }: VoiceSettings) => [recognition, voiceModel].flatMap((source) => (source.kind === "this-mac" ? [source.model] : []));

const withoutKey = <Source extends VoiceSource | VoiceModelSource>(source: Source): Source =>
  source.kind === "custom" ? { ...source, endpoint: { ...source.endpoint, apiKey: "" } } : source;

/** For clients that never show API keys, as they never get a profile's environment. */
export const voiceSettingsWithoutKeys = (settings: VoiceSettings): VoiceSettings => ({
  ...settings,
  recognition: withoutKey(settings.recognition),
  voiceModel: withoutKey(settings.voiceModel),
});
