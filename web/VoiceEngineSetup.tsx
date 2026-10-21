import { useState } from "react";
import { gigabytes, voiceEngineStepLabels, type EngineServer, type EngineServerState, type VoiceEngineSetup, type VoiceEngineStatus } from "../shared/voice-engine.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";

const setUp = (withVoiceModel: boolean) => connection.send({ type: "voice.engine.set-up", withVoiceModel });

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

interface VoiceModelChoice {
  withVoiceModel: boolean;
  setWithVoiceModel: (withVoiceModel: boolean) => void;
}

function NotSetUp({ engine: { setup, diskBytes }, choice: { withVoiceModel, setWithVoiceModel } }: { engine: VoiceEngineStatus; choice: VoiceModelChoice }) {
  const disk = gigabytes(diskBytes.base + (withVoiceModel ? diskBytes.voiceModel : 0));
  return (
    <>
      <p className="hint">
        Mirador can run speech recognition and the voice model here, so you need no server of your own. They take about {disk} of disk.
      </p>
      <div className="sending-settings">
        <label data-hint={hints.voiceEngineVoiceModel}>
          <input type="checkbox" checked={withVoiceModel} onChange={(event) => setWithVoiceModel(event.target.checked)} />
          Include the voice model, which translates ({gigabytes(diskBytes.voiceModel)})
        </label>
        <button type="button" onClick={() => setUp(withVoiceModel)}>
          {setup.state === "failed" ? "Try again" : "Set up voice on this Mac"}
        </button>
      </div>
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

const serverNames: Record<EngineServer, string> = { speech: "Speech recognition", voiceModel: "Voice model" };

const minutes = (count: number) => `${count} minute${count === 1 ? "" : "s"}`;

function serverStateText(state: EngineServerState, idleMinutes: number) {
  switch (state) {
    case "stopped":
      return "Unloaded. It loads again when next needed, which takes about 15 seconds.";
    case "loading":
      return "Loading…";
    case "ready":
      return `Loaded. It unloads after ${minutes(idleMinutes)} unused.`;
  }
}

function ServerStates({ servers, withVoiceModel, idleMinutes }: { servers: VoiceEngineStatus["servers"]; withVoiceModel: boolean; idleMinutes: number }) {
  const shown: EngineServer[] = withVoiceModel ? ["speech", "voiceModel"] : ["speech"];
  return (
    <ul className="voice-engine-servers" aria-label="Models on this Mac">
      {shown.map((server) => (
        <li key={server} data-state={servers[server]}>
          <span className="voice-engine-server-name">{serverNames[server]}</span> {serverStateText(servers[server], idleMinutes)}
        </li>
      ))}
    </ul>
  );
}

function SetUp({ setup, engine, idleMinutes }: { setup: Extract<VoiceEngineSetup, { state: "set-up" }>; engine: VoiceEngineStatus; idleMinutes: IdleMinutes }) {
  return (
    <>
      <div className="sending-settings">
        <span>
          Set up with speech recognition{setup.withVoiceModel ? " and the voice model" : ""}, using {gigabytes(setup.bytesOnDisk)}.
        </span>
        {!setup.withVoiceModel && (
          <button type="button" onClick={() => setUp(true)}>
            Add the voice model ({gigabytes(engine.diskBytes.voiceModel)})
          </button>
        )}
        <ConfirmButton className="danger" label="Remove voice from this Mac" armedText="Remove?" armedHint={hints.removeVoiceEngineArmed} onConfirm={() => connection.send({ type: "voice.engine.remove" })}>
          Remove
        </ConfirmButton>
      </div>
      <ServerStates servers={engine.servers} withVoiceModel={setup.withVoiceModel} idleMinutes={idleMinutes.saved} />
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
export function VoiceEngineSetupPanel({ engine, idleMinutes }: { engine: VoiceEngineStatus; idleMinutes: IdleMinutes }) {
  const { setup } = engine;
  const [withVoiceModel, setWithVoiceModel] = useState(true);
  if (setup.state === "unsupported") return null;
  return (
    <fieldset className="voice-service voice-engine">
      <legend>Voice on this Mac</legend>
      {setup.state === "setting-up" && <SetupProgress setup={setup} />}
      {setup.state === "set-up" && <SetUp setup={setup} engine={engine} idleMinutes={idleMinutes} />}
      {(setup.state === "not-set-up" || setup.state === "failed") && <NotSetUp engine={engine} choice={{ withVoiceModel, setWithVoiceModel }} />}
    </fieldset>
  );
}
