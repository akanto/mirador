import { useState } from "react";
import { gigabytes, voiceEngineStepLabels, type VoiceEngineSetup, type VoiceEngineStatus } from "../shared/voice-engine.ts";
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

function SetUp({ setup, voiceModelBytes }: { setup: Extract<VoiceEngineSetup, { state: "set-up" }>; voiceModelBytes: number }) {
  return (
    <div className="sending-settings">
      <span>
        Set up with speech recognition{setup.withVoiceModel ? " and the voice model" : ""}, using {gigabytes(setup.bytesOnDisk)}.
      </span>
      {!setup.withVoiceModel && (
        <button type="button" onClick={() => setUp(true)}>
          Add the voice model ({gigabytes(voiceModelBytes)})
        </button>
      )}
      <ConfirmButton className="danger" label="Remove voice from this Mac" armedText="Remove?" armedHint={hints.removeVoiceEngineArmed} onConfirm={() => connection.send({ type: "voice.engine.remove" })}>
        Remove
      </ConfirmButton>
    </div>
  );
}

/** Mirador's own speech engine, on Macs with Apple silicon. The voice model choice outlasts a cancelled setup. */
export function VoiceEngineSetupPanel({ engine }: { engine: VoiceEngineStatus }) {
  const { setup } = engine;
  const [withVoiceModel, setWithVoiceModel] = useState(true);
  if (setup.state === "unsupported") return null;
  return (
    <fieldset className="voice-service voice-engine">
      <legend>Voice on this Mac</legend>
      {setup.state === "setting-up" && <SetupProgress setup={setup} />}
      {setup.state === "set-up" && <SetUp setup={setup} voiceModelBytes={engine.diskBytes.voiceModel} />}
      {(setup.state === "not-set-up" || setup.state === "failed") && <NotSetUp engine={engine} choice={{ withVoiceModel, setWithVoiceModel }} />}
    </fieldset>
  );
}
