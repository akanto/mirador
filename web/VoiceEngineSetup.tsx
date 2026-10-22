import { useState } from "react";
import { gigabytes, voiceEngineStepLabels, type EngineServer, type EngineServerState, type VoiceEngineSetup, type VoiceEngineStatus } from "../shared/voice-engine.ts";
import {
  bestFitting,
  choosableModels,
  ENGINE_PACKAGES_BYTES,
  fitsMemory,
  modelsFor,
  SPOKEN_VOICE,
  type ChoosableModel,
  type EngineService,
} from "../shared/voice-engine-models.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { modelChoice, tooLittleMemoryForVoiceModel } from "./voice-models.ts";

/** Sets voice up on this Mac with the models, or adds them once it is set up. */
export const setUpModels = (models: string[]) => connection.send({ type: "voice.engine.set-up", models });

function SetupProgress({ setup: { step, done, total } }: { setup: Extract<VoiceEngineSetup, { state: "setting-up" }> }) {
  const counted = total > 0;
  return (
    <div className="voice-engine-progress">
      <span>{counted ? `${voiceEngineStepLabels[step]}: ${gigabytes(done)} of ${gigabytes(total)}` : `${voiceEngineStepLabels[step]}…`}</span>
      <progress aria-label="Setting up voice on this Mac" value={counted ? done : undefined} max={counted ? total : undefined} />
      <button type="button" onClick={() => connection.send({ type: "voice.engine.cancel" })}>
        Cancel
      </button>
    </div>
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

/** Saved with the rest of the voice settings, so the panel shows the saved time and edits the draft. */
interface IdleMinutes {
  saved: number;
  draft: number;
  change: (minutes: number) => void;
}

const serviceNames: Record<EngineService, string> = { recognition: "Speech recognition", voiceModel: "Voice model", speaking: "Hungarian reply voice" };
const serverOf: Record<EngineService, EngineServer> = { recognition: "speech", voiceModel: "voiceModel", speaking: "speaking" };

const minutes = (count: number) => `${count} minute${count === 1 ? "" : "s"}`;

function serverStateText(state: EngineServerState, idleMinutes: number) {
  switch (state) {
    case "stopped":
      return "Unloaded. It loads when next needed, usually in 5 to 15 seconds.";
    case "loading":
      return "Loading…";
    case "ready":
      return `Loaded. It unloads after ${minutes(idleMinutes)} unused.`;
  }
}

/** Only a model the saved settings use loads, so only its row tells whether it is loaded, and only the others can be removed. */
function ModelOnThisMac({ model, inUse, state, idleMinutes }: { model: ChoosableModel; inUse: boolean; state: EngineServerState; idleMinutes: number }) {
  return (
    <li data-state={inUse ? state : "stopped"}>
      <span>
        <span className="voice-engine-server-name">{serviceNames[model.service]}</span> {model.name}, {gigabytes(model.bytes)}
        {model.nonCommercial ? ", for non-commercial use only" : ""}. {inUse ? serverStateText(state, idleMinutes) : "Not in use."}
      </span>
      {inUse ? (
        <button type="button" className="danger" aria-label={`Remove ${model.name}`} data-hint={hints.voiceEngineModelInUse} aria-disabled="true">
          Remove
        </button>
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
    </li>
  );
}

function AddModel({ onDisk, memoryBytes }: { onDisk: string[]; memoryBytes: number }) {
  const [picked, setPicked] = useState<string | null>(null);
  const missing = choosableModels.filter(({ id }) => !onDisk.includes(id));
  const fitting = missing.filter((model) => fitsMemory(model, memoryBytes));
  const chosen = fitting.find(({ id }) => id === picked) ?? fitting[0];
  if (missing.length === 0) return null;
  return (
    <div className="sending-settings">
      <label data-hint={hints.voiceEngineAddModel}>
        Add
        <select value={chosen?.id ?? ""} onChange={(event) => setPicked(event.target.value)}>
          {!chosen && <option value="">None that fits this Mac</option>}
          {missing.map((model) => (
            <option key={model.id} value={model.id} disabled={!fitsMemory(model, memoryBytes)}>
              {serviceNames[model.service]}: {modelChoice(model, memoryBytes)}
            </option>
          ))}
        </select>
      </label>
      {chosen && (
        <button type="button" onClick={() => setUpModels([chosen.id])}>
          Download ({gigabytes(chosen.bytes)})
        </button>
      )}
    </div>
  );
}

function SetUp({
  setup,
  engine,
  inUse,
  idleMinutes,
}: {
  setup: Extract<VoiceEngineSetup, { state: "set-up" }>;
  engine: VoiceEngineStatus;
  inUse: string[];
  idleMinutes: IdleMinutes;
}) {
  const onDisk = choosableModels.filter(({ id }) => engine.onDisk.includes(id));
  return (
    <>
      <div className="sending-settings">
        <span>Set up, using {gigabytes(setup.bytesOnDisk)}.</span>
        <ConfirmButton className="danger" label="Remove voice from this Mac" armedText="Remove?" armedHint={hints.removeVoiceEngineArmed} onConfirm={() => connection.send({ type: "voice.engine.remove" })}>
          Remove all
        </ConfirmButton>
      </div>
      {setup.problem && (
        <p className="voice-engine-problem" role="alert">
          {setup.problem}
        </p>
      )}
      <ul className="voice-engine-servers" aria-label="Models on this Mac">
        {onDisk.map((model) => (
          <ModelOnThisMac key={model.id} model={model} inUse={inUse.includes(model.id)} state={engine.servers[serverOf[model.service]]} idleMinutes={idleMinutes.saved} />
        ))}
      </ul>
      <AddModel onDisk={engine.onDisk} memoryBytes={engine.memoryBytes} />
      <div className="sending-settings">
        <label data-hint={hints.voiceEngineIdle}>
          Unload after
          <input
            type="number"
            className="voice-engine-idle"
            min={1}
            max={1440}
            step={1}
            value={Number.isNaN(idleMinutes.draft) ? "" : idleMinutes.draft}
            onChange={(event) => idleMinutes.change(event.target.valueAsNumber)}
          />
          minutes unused
        </label>
      </div>
    </>
  );
}

/** Mirador's own speech engine, on Macs with Apple silicon. The voice model choice outlasts a cancelled setup. */
export function VoiceEngineSetupPanel({ engine, inUse, idleMinutes }: { engine: VoiceEngineStatus; inUse: string[]; idleMinutes: IdleMinutes }) {
  const { setup } = engine;
  const [picked, pick] = useState<string | null | undefined>(undefined);
  if (setup.state === "unsupported") return null;
  return (
    <fieldset className="voice-service voice-engine">
      <legend>Voice on this Mac</legend>
      {setup.state === "setting-up" && <SetupProgress setup={setup} />}
      {setup.state === "set-up" && <SetUp setup={setup} engine={engine} inUse={inUse} idleMinutes={idleMinutes} />}
      {(setup.state === "not-set-up" || setup.state === "failed") && <NotSetUp engine={engine} choice={{ picked, pick }} />}
    </fieldset>
  );
}
