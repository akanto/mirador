import { useEffect, useMemo, useState } from "react";
import { knownModes } from "../shared/config-options.ts";
import { askModeLabels, harnessIds, harnessLabels, type AskMode, type Conversation, type HarnessId, type Profile } from "../shared/model.ts";
import { maskSecrets, parseEnvironment } from "../shared/profile-environment.ts";
import type { ProfileDraft } from "../shared/protocol.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { useTypingAidAttributes } from "./typing-aids.ts";

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
  const typingAidAttributes = useTypingAidAttributes();
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
      {...typingAidAttributes}
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

const AGENTS_OWN_MODE = "";

/** Agent's default first, then the modes the agent listed last, and the profile's own if the agent has not listed it yet. */
function modeChoices(conversations: Conversation[], harness: HarnessId, saved: string) {
  const known = knownModes(conversations, harness).map(({ value, name }) => ({ value, name }));
  const savedButUnknown = saved !== AGENTS_OWN_MODE && !known.some(({ value }) => value === saved) ? [{ value: saved, name: saved }] : [];
  return [{ value: AGENTS_OWN_MODE, name: "Agent's default" }, ...known, ...savedButUnknown];
}

/** A new profile runs an agent this machine has; one named after its agent keeps following the agent picked until it is renamed. */
function ProfileEditor({
  profile,
  conversations,
  installedAgents,
  namedAfterAgent = false,
  isOnlyProfile = false,
  onSaved,
}: {
  profile: Profile | undefined;
  conversations: Conversation[];
  installedAgents: HarnessId[];
  namedAfterAgent?: boolean;
  isOnlyProfile?: boolean;
  onSaved: (profileId: string) => void;
}) {
  const firstHarness = profile?.harness ?? installedAgents[0] ?? "claude";
  const [name, setName] = useState(profile?.name ?? (namedAfterAgent ? harnessLabels[firstHarness] : ""));
  const [harness, setHarness] = useState<HarnessId>(firstHarness);
  const [environment, setEnvironment] = useState(profile?.environment ?? "");
  const [prelaunch, setPrelaunch] = useState(profile?.prelaunch ?? "");
  const [mode, setMode] = useState(profile?.mode ?? AGENTS_OWN_MODE);
  const [bypassPermissions, setBypassPermissions] = useState(profile?.bypassPermissions ?? false);
  const [askMode, setAskMode] = useState<AskMode>(profile?.askMode ?? "wait");
  const [savedOnce, setSavedOnce] = useState(false);
  const typingAidAttributes = useTypingAidAttributes();
  const { save, saving } = useSaveProfile((profileId) => {
    setSavedOnce(true);
    onSaved(profileId);
  });
  const { errors } = useMemo(() => parseEnvironment(environment), [environment]);
  const unchanged =
    profile &&
    name === profile.name &&
    environment === profile.environment &&
    prelaunch === profile.prelaunch &&
    mode === (profile.mode ?? AGENTS_OWN_MODE) &&
    bypassPermissions === profile.bypassPermissions &&
    askMode === profile.askMode;

  const deleteProfile = () => profile && connection.send({ type: "profile.delete", profileId: profile.id });

  return (
    <form
      className="profile-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save({ id: profile?.id, name, harness, environment, prelaunch, mode: mode || null, bypassPermissions, askMode });
      }}
    >
      <label>
        <span>Name</span>
        <input {...typingAidAttributes} aria-label="Profile name" value={name} placeholder="e.g. work, local qwen" onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>Agent</span>
        <select
          aria-label="Profile agent"
          value={harness}
          disabled={Boolean(profile)}
          title={profile ? "A profile's agent is fixed: its conversations keep running on it." : undefined}
          onChange={(event) => {
            const picked = event.target.value as HarnessId;
            if (name === harnessLabels[harness]) setName(harnessLabels[picked]);
            setHarness(picked);
            setMode(AGENTS_OWN_MODE);
          }}
        >
          {harnessIds.map((id) => (
            <option key={id} value={id} disabled={!profile && !installedAgents.includes(id)}>
              {installedAgents.includes(id) ? harnessLabels[id] : `${harnessLabels[id]} (not installed)`}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Mode</span>
        <select aria-label="Profile mode" value={mode} onChange={(event) => setMode(event.target.value)}>
          {modeChoices(conversations, harness, mode).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.name}
            </option>
          ))}
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" aria-label="Profile YOLO" checked={bypassPermissions} onChange={(event) => setBypassPermissions(event.target.checked)} />
        <span>YOLO: approve whatever the agent asks permission for</span>
      </label>
      <label>
        <span>Questions</span>
        <select aria-label="Profile questions" value={askMode} onChange={(event) => setAskMode(event.target.value as AskMode)}>
          {(Object.keys(askModeLabels) as AskMode[]).map((choice) => (
            <option key={choice} value={choice}>
              {askModeLabels[choice]}
            </option>
          ))}
        </select>
      </label>
      <div className="hint">
        A conversation takes the mode, YOLO and Questions when it starts with this profile or moves to it; its own menus change them
        after that. The modes are the ones the agent last listed, so they show once one of its conversations has run.
      </div>
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
          {...typingAidAttributes}
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
        {profile && !isOnlyProfile && (
          <ConfirmButton className="danger" label="Delete profile" armedText="Delete?" armedHint={hints.deleteProfileArmed} onConfirm={deleteProfile}>
            Delete
          </ConfirmButton>
        )}
        {savedOnce && unchanged && <span className="saved">Saved</span>}
      </div>
      {profile && (
        <div className="hint">Saving a changed environment or pre-launch command restarts this profile's agent; a turn in progress stops.</div>
      )}
      {isOnlyProfile && <div className="hint">This is your only profile, and every conversation needs one, so it stays until you create another.</div>}
    </form>
  );
}

/** With no profile yet, the main pane offers the first: an agent this machine has, named after it, run as it is set up here. */
export function FirstProfile({ installedAgents, conversations }: { installedAgents: HarnessId[]; conversations: Conversation[] }) {
  if (installedAgents.length === 0) {
    return (
      <div className="empty">
        <h2>Install an agent to start</h2>
        <p>Mirador runs Claude Code or opencode, and this machine has neither. Install one, then reload this page.</p>
      </div>
    );
  }
  return (
    <div className="empty first-profile">
      <h2>Set up a profile to start</h2>
      <p>
        Every conversation runs on a profile: an agent and the environment it starts with. With nothing more set, it runs the agent as
        it is set up on this machine. You can add profiles for other accounts, gateways or local models later in Profiles.
      </p>
      <ProfileEditor profile={undefined} conversations={conversations} installedAgents={installedAgents} namedAfterAgent onSaved={() => {}} />
    </div>
  );
}

export function ProfilesDialog({
  profiles,
  conversations,
  installedAgents,
  onClose,
}: {
  profiles: Profile[];
  conversations: Conversation[];
  installedAgents: HarnessId[];
  onClose: () => void;
}) {
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
          uses. Every conversation runs on one; with no environment set, the agent runs as it is set up on this machine.
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
          <ProfileEditor
            key={selected?.id ?? NEW_PROFILE}
            profile={selected}
            conversations={conversations}
            installedAgents={installedAgents}
            isOnlyProfile={profiles.length === 1 && selected !== undefined}
            onSaved={setSelectedId}
          />
        </div>
      </div>
    </div>
  );
}
