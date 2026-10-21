import type { Profile } from "../../shared/model.ts";
import { AUTO_LANGUAGE, isEnglish, type CustomEndpoint, type Dictation, type VoiceModelSource, type VoiceSettings, type VoiceSource } from "../../shared/voice.ts";
import { profileEnvironment } from "../acp/harnesses.ts";
import { transcribe, type ChatEndpoint } from "./endpoints.ts";
import { translated } from "./translation.ts";

export type ThisMacService = "recognition" | "voiceModel";

/** Where Mirador's own engine on this Mac serves a service, starting it first when it isn't running. */
export type ThisMacEndpoints = (service: ThisMacService) => Promise<CustomEndpoint>;

/** Voice can't do what was asked as it is set up; Settings → Voice can change that. */
export class VoiceUnavailable extends Error {}

export const notSetUpOnThisMac: ThisMacEndpoints = () => Promise.reject(new VoiceUnavailable("Voice isn't set up on this Mac yet."));

const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";
const DEFAULT_OPENAI_URL = "https://api.openai.com/v1";

/** A profile's API as its agent would reach it: Anthropic's names win, as Claude Code reads them first. */
export function profileVoiceModel(profile: Profile, model: string): ChatEndpoint {
  const environment = profileEnvironment(profile);
  const apiKey = environment.ANTHROPIC_API_KEY || null;
  const authToken = environment.ANTHROPIC_AUTH_TOKEN || null;
  if (apiKey || authToken) return { api: "anthropic", baseUrl: environment.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_URL, apiKey, authToken, model };
  if (environment.OPENAI_API_KEY) {
    return { api: "openai", url: environment.OPENAI_BASE_URL || DEFAULT_OPENAI_URL, apiKey: environment.OPENAI_API_KEY, model, turnsThinkingOff: false };
  }
  throw new VoiceUnavailable(`The profile ${profile.name} has no ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY in its environment.`);
}

export class Voice {
  constructor(
    private readonly settings: () => VoiceSettings,
    private readonly profileById: (profileId: string) => Profile | undefined,
    private readonly thisMac: ThisMacEndpoints = notSetUpOnThisMac,
  ) {}

  /** What a clip of 16 kHz mono WAV says, in English when the user has translation on. */
  async dictation(clip: Blob): Promise<Dictation> {
    const settings = this.settings();
    const recognition = await this.recognitionEndpoint(settings.recognition);
    const chosenLanguage = settings.language === AUTO_LANGUAGE ? null : settings.language;
    const heard = await transcribe(recognition, clip, chosenLanguage);
    const language = chosenLanguage ?? heard.language;
    const untranslated = { text: heard.text, original: null, language };
    if (!settings.translateToEnglish || heard.text === "" || (language && isEnglish(language))) return untranslated;
    const voiceModel = await this.voiceModelEndpoint(settings.voiceModel);
    if (!voiceModel) return untranslated;
    const english = await translated(voiceModel, heard.text, { spoken: true });
    return english === heard.text ? untranslated : { text: english, original: heard.text, language };
  }

  private async recognitionEndpoint(source: VoiceSource) {
    if (source.kind === "off") throw new VoiceUnavailable("Voice is off. Settings → Voice can turn it on.");
    return source.kind === "this-mac" ? this.thisMac("recognition") : source.endpoint;
  }

  private async voiceModelEndpoint(source: VoiceModelSource): Promise<ChatEndpoint | null> {
    switch (source.kind) {
      case "off":
        return null;
      case "this-mac":
        return { api: "openai", ...(await this.thisMac("voiceModel")), turnsThinkingOff: true };
      case "custom":
        return { api: "openai", ...source.endpoint, turnsThinkingOff: false };
      case "profile": {
        const profile = this.profileById(source.profileId);
        if (!profile) throw new VoiceUnavailable("The voice model's profile no longer exists. Settings → Voice can pick another.");
        return profileVoiceModel(profile, source.model);
      }
    }
  }
}
