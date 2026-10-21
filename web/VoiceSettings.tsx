import { useEffect, useState } from "react";
import type { Profile } from "../shared/model.ts";
import { AUTO_LANGUAGE, isEnglish, type CustomEndpoint, type VoiceModelSource, type VoiceSettings as Settings, type VoiceSource } from "../shared/voice.ts";
import { hints } from "./hints.ts";
import { saveSetting } from "./saved-setting.ts";

/** Languages Whisper recognizes well, as codes it takes. */
const spokenLanguages = ["en", "hu", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "sk", "ro", "uk", "ru", "sv", "da", "fi", "no", "el", "tr", "ja", "zh", "ko", "hi", "ar", "he"];

const languageNames = new Intl.DisplayNames([navigator.language], { type: "language" });
const languageName = (code: string) => languageNames.of(code) ?? code;

const noEndpoint: CustomEndpoint = { url: "", apiKey: "", model: "" };

function EndpointFields({ endpoint, modelPlaceholder, onChange }: { endpoint: CustomEndpoint; modelPlaceholder: string; onChange: (endpoint: CustomEndpoint) => void }) {
  return (
    <div className="sending-settings voice-endpoint">
      <label data-hint={hints.voiceAddress}>
        Address
        <input type="url" value={endpoint.url} placeholder="http://127.0.0.1:8000/v1" spellCheck={false} onChange={(event) => onChange({ ...endpoint, url: event.target.value })} />
      </label>
      <label>
        API key
        <input type="password" value={endpoint.apiKey} placeholder="None" autoComplete="off" onChange={(event) => onChange({ ...endpoint, apiKey: event.target.value })} />
      </label>
      <label>
        Model
        <input type="text" value={endpoint.model} placeholder={modelPlaceholder} spellCheck={false} onChange={(event) => onChange({ ...endpoint, model: event.target.value })} />
      </label>
    </div>
  );
}

function RecognitionSettings({ source, onChange }: { source: VoiceSource; onChange: (source: VoiceSource) => void }) {
  const choose = (kind: string) => onChange(kind === "custom" ? { kind, endpoint: source.kind === "custom" ? source.endpoint : noEndpoint } : { kind: "off" });
  return (
    <fieldset className="voice-service">
      <legend>Speech recognition</legend>
      <div className="sending-settings">
        <label data-hint={hints.voiceRecognition}>
          Turns speech into text
          <select value={source.kind} onChange={(event) => choose(event.target.value)}>
            <option value="off">Off</option>
            <option value="custom">With a server of your own</option>
          </select>
        </label>
      </div>
      {source.kind === "custom" && (
        <EndpointFields endpoint={source.endpoint} modelPlaceholder="whisper-1" onChange={(endpoint) => onChange({ kind: "custom", endpoint })} />
      )}
    </fieldset>
  );
}

function VoiceModelSettings({ source, profiles, onChange }: { source: VoiceModelSource; profiles: Profile[]; onChange: (source: VoiceModelSource) => void }) {
  const choose = (kind: string) => {
    if (kind === "custom") return onChange({ kind, endpoint: source.kind === "custom" ? source.endpoint : noEndpoint });
    if (kind === "profile") return onChange({ kind, profileId: source.kind === "profile" ? source.profileId : (profiles[0]?.id ?? ""), model: source.kind === "profile" ? source.model : "" });
    onChange({ kind: "off" });
  };
  return (
    <fieldset className="voice-service">
      <legend>Voice model</legend>
      <div className="sending-settings">
        <label data-hint={hints.voiceModel}>
          Translates
          <select value={source.kind} onChange={(event) => choose(event.target.value)}>
            <option value="off">Off</option>
            <option value="custom">With a server of your own</option>
            <option value="profile" disabled={profiles.length === 0}>
              With a profile's API
            </option>
          </select>
        </label>
        {source.kind === "profile" && (
          <>
            <label data-hint={hints.voiceModelProfile}>
              Profile
              <select value={source.profileId} onChange={(event) => onChange({ ...source, profileId: event.target.value })}>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <input type="text" value={source.model} placeholder="claude-opus-5-5" spellCheck={false} onChange={(event) => onChange({ ...source, model: event.target.value })} />
            </label>
          </>
        )}
      </div>
      {source.kind === "custom" && (
        <EndpointFields endpoint={source.endpoint} modelPlaceholder="gpt-5-mini" onChange={(endpoint) => onChange({ kind: "custom", endpoint })} />
      )}
    </fieldset>
  );
}

/** Kept by the host, so every browser and the phone dictate the same way; saved together, as an address and its key belong together. */
export function VoiceSettings({ settings, profiles }: { settings: Settings; profiles: Profile[] }) {
  const [draft, setDraft] = useState(settings);
  const [outcome, setOutcome] = useState<string | null>(null);
  useEffect(() => setDraft(settings), [settings]);
  const change = (next: Partial<Settings>) => {
    setDraft({ ...draft, ...next });
    setOutcome(null);
  };
  const save = async () => setOutcome((await saveSetting((requestId) => ({ type: "voice.set-settings", requestId, settings: draft }))) ?? "Saved.");
  const unsaved = JSON.stringify(draft) !== JSON.stringify(settings);
  return (
    <>
      <h3>Voice</h3>
      <p className="hint">
        Speak to agents: Mirador turns what you say into text in the message box, in English if you like, before anything is sent. Kept by the host for every browser and
        the phone.
      </p>
      <RecognitionSettings source={draft.recognition} onChange={(recognition) => change({ recognition })} />
      <VoiceModelSettings source={draft.voiceModel} profiles={profiles} onChange={(voiceModel) => change({ voiceModel })} />
      <div className="sending-settings">
        <label data-hint={hints.voiceLanguage}>
          You speak
          <select value={draft.language} onChange={(event) => change({ language: event.target.value })}>
            <option value={AUTO_LANGUAGE}>Any language, told apart by itself</option>
            {spokenLanguages.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
              </option>
            ))}
          </select>
        </label>
        {!isEnglish(draft.language) && (
          <label data-hint={draft.voiceModel.kind === "off" ? hints.translateNeedsVoiceModel : hints.translateToEnglish}>
            <input
              type="checkbox"
              checked={draft.translateToEnglish && draft.voiceModel.kind !== "off"}
              disabled={draft.voiceModel.kind === "off"}
              onChange={(event) => change({ translateToEnglish: event.target.checked })}
            />
            Translate into English
          </label>
        )}
      </div>
      <div className="voice-save">
        <button type="button" disabled={!unsaved} onClick={save}>
          Save
        </button>
        <span className="hint" role="status">
          {outcome}
        </span>
      </div>
    </>
  );
}
