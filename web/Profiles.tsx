import { useEffect, useMemo, useState } from "react";
import { harnessIds, harnessLabels, type HarnessId, type Profile } from "../shared/model.ts";
import { maskSecrets, parseEnvironment } from "../shared/profile-environment.ts";
import type { ProfileDraft } from "../shared/protocol.ts";
import { connection } from "./connection.ts";

const NEW_PROFILE = "new";

const environmentPlaceholders: Record<HarnessId, string> = {
  claude: `ANTHROPIC_BASE_URL=http://localhost:8080
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_MODEL=qwen3-coder
-u ANTHROPIC_API_KEY`,
  opencode: `OPENCODE_CONFIG=/Users/you/.config/opencode/work.json
# or inline, merged over your opencode config:
OPENCODE_CONFIG_CONTENT='{"model":"llama.cpp/qwen3"}'`,
};

function useSaveProfile(onSaved: (profileId: string) => void) {
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  useEffect(
    () =>
      connection.onMessage((message) => {
        if (message.type === "profile.saved" && message.requestId === pendingRequest) {
          setPendingRequest(null);
          onSaved(message.profileId);
        }
        if (message.type === "error") setPendingRequest(null);
      }),
    [pendingRequest, onSaved],
  );
  const save = (profile: ProfileDraft) => {
    const requestId = crypto.randomUUID();
    if (connection.send({ type: "profile.save", requestId, profile })) setPendingRequest(requestId);
  };
  return { save, saving: pendingRequest !== null };
}

function EnvironmentField({
  value,
  harness,
  onChange,
  startRevealed,
}: {
  value: string;
  harness: HarnessId;
  onChange: (value: string) => void;
  startRevealed: boolean;
}) {
  const [revealed, setRevealed] = useState(startRevealed);
  if (!revealed) {
    return (
      <div className="environment-preview">
        <pre aria-label="Environment (secrets hidden)">{maskSecrets(value) || "(nothing set)"}</pre>
        <button onClick={() => setRevealed(true)}>Edit environment</button>
      </div>
    );
  }
  return (
    <textarea
      aria-label="Environment"
      className="environment"
      rows={10}
      spellCheck={false}
      placeholder={environmentPlaceholders[harness]}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function ProfileEditor({ profile, onSaved }: { profile: Profile | undefined; onSaved: (profileId: string) => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [harness, setHarness] = useState<HarnessId>(profile?.harness ?? "claude");
  const [environment, setEnvironment] = useState(profile?.environment ?? "");
  const [prelaunch, setPrelaunch] = useState(profile?.prelaunch ?? "");
  const [savedOnce, setSavedOnce] = useState(false);
  const { save, saving } = useSaveProfile((profileId) => {
    setSavedOnce(true);
    onSaved(profileId);
  });
  const { errors } = useMemo(() => parseEnvironment(environment), [environment]);
  const unchanged = profile && name === profile.name && environment === profile.environment && prelaunch === profile.prelaunch;

  const deleteProfile = () => {
    if (profile && confirm(`Delete profile "${profile.name}"? Its conversations can continue with another profile.`)) {
      connection.send({ type: "profile.delete", profileId: profile.id });
    }
  };

  return (
    <form
      className="profile-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save({ id: profile?.id, name, harness, environment, prelaunch });
      }}
    >
      <label>
        <span>Name</span>
        <input aria-label="Profile name" value={name} placeholder="e.g. work, local qwen" onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>Agent</span>
        <select
          aria-label="Profile agent"
          value={harness}
          disabled={Boolean(profile)}
          title={profile ? "A profile's agent is fixed: its conversations keep running on it." : undefined}
          onChange={(event) => setHarness(event.target.value as HarnessId)}
        >
          {harnessIds.map((id) => (
            <option key={id} value={id}>
              {harnessLabels[id]}
            </option>
          ))}
        </select>
      </label>
      <div className="field-label">Environment</div>
      <EnvironmentField value={environment} harness={harness} onChange={setEnvironment} startRevealed={!profile} />
      <div className="hint">
        One per line: <code>KEY=value</code>, <code>-u KEY</code> to unset, <code># comment</code>. The lines of a{" "}
        <code>claude_env=( … )</code> array paste as they are. Values are literal; <code>$VAR</code> is not expanded.
      </div>
      {errors.length > 0 && (
        <ul className="form-errors">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <label>
        <span>Pre-launch command (optional)</span>
        <textarea
          aria-label="Pre-launch command"
          rows={3}
          spellCheck={false}
          placeholder="lsof -ti:8083 >/dev/null || (python3 ~/proxy.py >> ~/proxy.log 2>&1 &)"
          value={prelaunch}
          onChange={(event) => setPrelaunch(event.target.value)}
        />
      </label>
      <div className="hint">
        Runs with your shell and this environment before the agent starts. It must finish within a minute; start long-running
        proxies in the background.
      </div>
      <div className="form-actions">
        <button type="submit" disabled={saving || errors.length > 0 || !name.trim() || unchanged}>
          {profile ? "Save" : "Create profile"}
        </button>
        {profile && (
          <button type="button" className="danger" onClick={deleteProfile}>
            Delete
          </button>
        )}
        {savedOnce && unchanged && <span className="saved">Saved</span>}
      </div>
      {profile && (
        <div className="hint">Saving a changed environment or pre-launch command restarts this profile's agent; a turn in progress stops.</div>
      )}
    </form>
  );
}

export function ProfilesDialog({ profiles, onClose }: { profiles: Profile[]; onClose: () => void }) {
  const [selectedId, setSelectedId] = useState(profiles[0]?.id ?? NEW_PROFILE);
  const selected = profiles.find(({ id }) => id === selectedId);

  useEffect(() => {
    if (selectedId !== NEW_PROFILE && !selected) setSelectedId(profiles[0]?.id ?? NEW_PROFILE);
  }, [selectedId, selected, profiles]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal profiles" role="dialog" aria-label="Profiles">
        <header>
          <h2>Profiles</h2>
          <button className="icon" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="hint">
          A profile is an agent plus the environment it starts with: which account, gateway, local model or opencode config it
          uses. Without a profile, agents use the environment the host was started with.
        </p>
        <div className="profiles-body">
          <ul className="profile-list">
            {profiles.map((profile) => (
              <li key={profile.id} className={profile.id === selectedId ? "selected" : ""} onClick={() => setSelectedId(profile.id)}>
                {profile.name}
                <span className="profile-agent">{harnessLabels[profile.harness]}</span>
              </li>
            ))}
            <li className={selectedId === NEW_PROFILE ? "selected" : ""} onClick={() => setSelectedId(NEW_PROFILE)}>
              + New profile
            </li>
          </ul>
          <ProfileEditor key={selected?.id ?? NEW_PROFILE} profile={selected} onSaved={setSelectedId} />
        </div>
      </div>
    </div>
  );
}
