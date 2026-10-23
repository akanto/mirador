import { useEffect, useRef, useState, type ReactNode } from "react";
import { gigabytes, voiceEngineStepLabels, type EngineServerState, type VoiceEngineSetup, type VoiceEngineStatus } from "../shared/voice-engine.ts";
import { bestFitting, choosableModels, ENGINE_PACKAGES_BYTES, fitsMemory, modelsFor, SPOKEN_VOICE, type ChoosableModel, type EngineService } from "../shared/voice-engine-models.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { modelChoice, modelState, tooLittleMemoryForVoiceModel } from "./voice-models.ts";

/** Sets voice up on this Mac with the models, or adds them once it is set up. */
export const setUpModels = (models: string[]) => connection.send({ type: "voice.engine.set-up", models });

type SettingUp = Extract<VoiceEngineSetup, { state: "setting-up" }>;

/** How far setup is: in the setup box the first time, then beside each model it adds. */
function DownloadProgress({ setup: { step, done, total }, label }: { setup: SettingUp; label: string }) {
  const counted = total > 0;
  return (
    <span className="voice-engine-progress">
      <span>{counted ? `${voiceEngineStepLabels[step]}: ${gigabytes(done)} of ${gigabytes(total)}` : `${voiceEngineStepLabels[step]}…`}</span>
      <progress aria-label={label} value={counted ? done : undefined} max={counted ? total : undefined} />
      <button type="button" onClick={() => connection.send({ type: "voice.engine.cancel" })}>
        Cancel
      </button>
    </span>
  );
}

/** The voice model picked for the first setup, by id, or null for none; undefined until the user picks, for the best one that fits. */
interface VoiceModelChoice {
  picked: string | null | undefined;
  pick: (model: string | null) => void;
}

function NotSetUp({ engine: { setup, memoryBytes }, choice }: { engine: VoiceEngineStatus; choice: VoiceModelChoice }) {
  const recognition = bestFitting("recognition", memoryBytes) ?? modelsFor("recognition")[0]!;
  const bestVoiceModel = bestFitting("voiceModel", memoryBytes);
  const voiceModel = choice.picked === undefined ? bestVoiceModel : modelsFor("voiceModel").find(({ id }) => id === choice.picked);
  const disk = gigabytes(ENGINE_PACKAGES_BYTES + SPOKEN_VOICE.bytes + recognition.bytes + (voiceModel?.bytes ?? 0));
  return (
    <>
      <p className="hint">Mirador can run speech recognition and a voice model here, so you need no server of your own. They take about {disk} of disk.</p>
      <div className="sending-settings">
        <label data-hint={hints.voiceEngineVoiceModel}>
          Voice model, which translates
          <select value={voiceModel?.id ?? ""} onChange={(event) => choice.pick(event.target.value || null)}>
            <option value="">None</option>
            {modelsFor("voiceModel").map((model) => (
              <option key={model.id} value={model.id} disabled={!fitsMemory(model, memoryBytes)}>
                {modelChoice(model, memoryBytes)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => setUpModels([recognition.id, ...(voiceModel ? [voiceModel.id] : [])])}>
          {setup.state === "failed" ? "Try again" : "Set up voice on this Mac"}
        </button>
      </div>
      {!bestVoiceModel && <p className="hint">{tooLittleMemoryForVoiceModel(memoryBytes)}</p>}
      {setup.state === "failed" && (
        <p className="voice-engine-problem" role="alert">
          {setup.problem}
        </p>
      )}
    </>
  );
}

/** Setting voice up on this Mac the first time. Once set up, models download where they are chosen and are listed under Models on this Mac. */
export function VoiceEngineSetupPanel({ engine }: { engine: VoiceEngineStatus }) {
  const { setup } = engine;
  const [picked, pick] = useState<string | null | undefined>(undefined);
  if (setup.state === "unsupported" || setup.state === "set-up" || engine.onDisk.length > 0) return null;
  return (
    <fieldset className="voice-service voice-engine">
      <legend>Voice on this Mac</legend>
      {setup.state === "setting-up" ? <DownloadProgress setup={setup} label="Setting up voice on this Mac" /> : <NotSetUp engine={engine} choice={{ picked, pick }} />}
    </fieldset>
  );
}

const serverStateNames: Record<EngineServerState, string> = { stopped: "Unloaded", loading: "Loading…", ready: "Loaded" };

/** Whether the server of a model in use has it loaded; the hint says when it loads or unloads. */
export function ServerState({ state, idleMinutes }: { state: EngineServerState; idleMinutes: number }) {
  return (
    <span className="voice-engine-state" data-state={state} data-hint={state === "ready" ? hints.voiceEngineLoaded(idleMinutes) : hints.voiceEngineUnloaded}>
      {serverStateNames[state]}
    </span>
  );
}

/** Beside a model chosen for this Mac: whether it is loaded, its download, or why this Mac can't have it. */
export function ModelBeside({ model, engine, idleMinutes }: { model: ChoosableModel; engine: VoiceEngineStatus; idleMinutes: number }) {
  const state = modelState(model, engine);
  switch (state.is) {
    case "on-disk":
      return <ServerState state={state.server} idleMinutes={idleMinutes} />;
    case "downloading":
      return <DownloadProgress setup={state.setup} label={`Downloading ${model.name}`} />;
    case "too-big":
      return <span className="hint">Needs a Mac with {state.neededGb} GB of memory.</span>;
    case "waiting-for-another-download":
      return (
        <button type="button" aria-disabled="true" data-hint={hints.voiceEngineDownloadWaits}>
          Download {gigabytes(model.bytes)}
        </button>
      );
    case "downloadable":
      return (
        <>
          <button type="button" onClick={() => setUpModels([model.id])}>
            Download {gigabytes(model.bytes)}
          </button>
          {state.problem && (
            <span className="voice-engine-problem" role="alert">
              {state.problem}
            </span>
          )}
        </>
      );
  }
}

const usedFor: Record<EngineService, string> = { recognition: "Speech recognition", voiceModel: "Voice model", speaking: "Hungarian replies" };

/** The engine removes nothing while a download goes on, so its Remove buttons wait. */
function RemoveWaitingForDownload({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button type="button" className="danger" aria-disabled="true" aria-label={label} data-hint={hints.voiceEngineRemoveWaits}>
      {children}
    </button>
  );
}

/** A model on this Mac, or one downloading; only one the saved settings don't use can be removed. */
function ModelRow({ model, engine, inUse }: { model: ChoosableModel; engine: VoiceEngineStatus; inUse: boolean }) {
  const { setup } = engine;
  const downloading = setup.state === "setting-up" && !engine.onDisk.includes(model.id) ? setup : null;
  return (
    <tr>
      <td className="voice-engine-model-name">
        {model.name}
        {model.nonCommercial && <span className="hint"> · non-commercial use only</span>}
      </td>
      <td>{usedFor[model.service]}</td>
      <td>{gigabytes(model.bytes)}</td>
      <td>
        {downloading ? (
          <DownloadProgress setup={downloading} label={`Downloading ${model.name}`} />
        ) : inUse ? (
          "In use"
        ) : setup.state === "setting-up" ? (
          <RemoveWaitingForDownload label={`Remove ${model.name}`}>Remove</RemoveWaitingForDownload>
        ) : (
          <ConfirmButton
            className="danger"
            label={`Remove ${model.name}`}
            armedText="Remove?"
            armedHint={hints.removeVoiceEngineModelArmed}
            onConfirm={() => connection.send({ type: "voice.engine.remove-model", model: model.id })}
          >
            Remove
          </ConfirmButton>
        )}
      </td>
    </tr>
  );
}

const IDLE_SAVE_DELAY_MS = 800;

/** Saved once the user stops changing it, as each minute typed or stepped would otherwise unload servers on its own. */
function IdleMinutes({ saved, onSave }: { saved: number; onSave: (minutes: number) => void }) {
  const [draft, setDraft] = useState(saved);
  const pending = useRef<Timer | null>(null);
  useEffect(() => setDraft(saved), [saved]);
  const saveNow = (minutes: number) => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    if (Number.isFinite(minutes) && minutes !== saved) onSave(minutes);
  };
  const change = (minutes: number) => {
    setDraft(minutes);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => saveNow(minutes), IDLE_SAVE_DELAY_MS);
  };
  return (
    <label data-hint={hints.voiceEngineIdle}>
      Unload after
      <input
        type="number"
        className="voice-engine-idle"
        min={1}
        max={1440}
        step={1}
        value={Number.isNaN(draft) ? "" : draft}
        onChange={(event) => change(event.target.valueAsNumber)}
        onBlur={() => saveNow(draft)}
      />
      minutes unused
    </label>
  );
}

/** What voice on this Mac keeps on disk, what each model is for, and how long a loaded one stays loaded. */
export function ModelsOnThisMac({
  engine,
  inUse,
  idleMinutes,
  onIdleMinutes,
  status,
}: {
  engine: VoiceEngineStatus;
  inUse: string[];
  idleMinutes: number;
  onIdleMinutes: (minutes: number) => void;
  status: ReactNode;
}) {
  const { setup } = engine;
  if (setup.state === "unsupported" || engine.onDisk.length === 0) return null;
  const listed = choosableModels.filter(({ id }) => engine.onDisk.includes(id) || (setup.state === "setting-up" && setup.models.includes(id)));
  return (
    <fieldset className="voice-service">
      <legend>Models on this Mac</legend>
      <table className="voice-engine-models" aria-label="Models on this Mac">
        <thead>
          <tr>
            <th>Model</th>
            <th>For</th>
            <th>Size</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="voice-engine-model-name">{SPOKEN_VOICE.name}</td>
            <td>English replies</td>
            <td>{gigabytes(SPOKEN_VOICE.bytes)}</td>
            <td>{inUse.includes(SPOKEN_VOICE.id) ? "In use" : <span data-hint={hints.spokenVoiceKept}>Kept</span>}</td>
          </tr>
          {listed.map((model) => (
            <ModelRow key={model.id} model={model} engine={engine} inUse={inUse.includes(model.id)} />
          ))}
        </tbody>
      </table>
      <div className="sending-settings">
        <IdleMinutes saved={idleMinutes} onSave={onIdleMinutes} />
      </div>
      <div className="sending-settings">
        {setup.state === "set-up" && <span>{gigabytes(setup.bytesOnDisk)} in all, with the speech engine.</span>}
        {setup.state === "setting-up" ? (
          <RemoveWaitingForDownload label="Remove voice from this Mac">Remove all</RemoveWaitingForDownload>
        ) : (
          <ConfirmButton className="danger" label="Remove voice from this Mac" armedText="Remove?" armedHint={hints.removeVoiceEngineArmed} onConfirm={() => connection.send({ type: "voice.engine.remove" })}>
            Remove all
          </ConfirmButton>
        )}
      </div>
      {status}
    </fieldset>
  );
}
