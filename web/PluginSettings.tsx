import { useEffect, useState, type FormEvent } from "react";
import { settingValue, type CatalogPlugin, type PluginInfo, type PluginNews, type PluginSettings as SettingsOfPlugin, type PluginSource, type PluginUpdate as FoundUpdate } from "../shared/apps.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { MIRADOR_VERSION } from "../shared/version.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";
import { hints } from "./hints.ts";
import { choosePluginSetting, usePluginSettings } from "./plugin-settings.ts";

type PluginsListed = Extract<ServerMessage, { type: "plugins.listed" }>;

/** Sends a change to the plugins and waits for it: null once done, else what went wrong, git's or the build's output included. */
async function changePlugins(send: (requestId: string) => ClientMessage): Promise<string | null> {
  try {
    return await connection.sendAndAwait(send, (message, requestId) => (message.type === "plugins.changed" && message.requestId === requestId ? message.problem : undefined));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function findNews(folder: string): Promise<PluginNews & { problem: string | null }> {
  try {
    return await connection.sendAndAwait(
      (requestId) => ({ type: "plugins.find-commits", requestId, folder }),
      (message, requestId) => (message.type === "plugins.commits-found" && message.requestId === requestId ? message : undefined),
    );
  } catch (error) {
    return { release: null, commits: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

function sourceLine(source: PluginSource) {
  switch (source.kind) {
    case "shipped":
      return `Comes with Mirador ${MIRADOR_VERSION}`;
    case "git":
      return [source.remote ?? "no remote", source.release ? "releases" : (source.branch ?? "no branch"), `${source.commit} ${source.subject}`].join(" · ");
    case "linked":
      return `Linked to ${source.target}`;
    case "folder":
      return "A folder put there by hand";
  }
}

type Updating =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "found"; news: PluginNews }
  | { step: "updating" }
  | { step: "failed"; problem: string };

/** How many plugins have new commits, as Mirador found by itself; nothing when none has. */
export function UpdatesWaiting({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="updates-waiting" data-hint={hints.pluginUpdatesWaiting} aria-label={`${count} ${count === 1 ? "plugin update" : "plugin updates"}`}>
      {count}
    </span>
  );
}

const isNothingNew = ({ release, commits }: PluginNews) => release === null && commits.length === 0;

function PluginUpdate({ plugin, found }: { plugin: PluginInfo; found: PluginNews | undefined }) {
  const [checked, setUpdating] = useState<Updating>({ step: "idle" });
  const updating: Updating = checked.step === "idle" && found ? { step: "found", news: found } : checked;
  const check = async () => {
    setUpdating({ step: "checking" });
    const { problem, ...news } = await findNews(plugin.folder);
    setUpdating(problem ? { step: "failed", problem } : { step: "found", news });
  };
  const update = async () => {
    setUpdating({ step: "updating" });
    const problem = await changePlugins((requestId) => ({ type: "plugins.update", requestId, folder: plugin.folder }));
    if (problem) setUpdating({ step: "failed", problem });
  };
  switch (updating.step) {
    case "idle":
      return (
        <button type="button" data-hint={hints.checkPluginUpdates} onClick={check}>
          Check for updates
        </button>
      );
    case "checking":
      return <span className="plugin-status">Checking for updates…</span>;
    case "found":
      if (isNothingNew(updating.news)) {
        return (
          <>
            <span className="plugin-status">Up to date.</span>
            <button type="button" data-hint={hints.checkPluginUpdates} onClick={check}>
              Check again
            </button>
          </>
        );
      }
      return (
        <>
          {updating.news.release && (
            <span className="plugin-release">
              {plugin.version ?? "?"} → {updating.news.release}
            </span>
          )}
          <ul className="plugin-commits" aria-label={`New commits of ${plugin.title ?? plugin.folder}`}>
            {updating.news.commits.map(({ commit, subject }) => (
              <li key={commit}>
                <code>{commit}</code> {subject}
              </li>
            ))}
          </ul>
          <button type="button" data-hint={hints.updatePlugin} onClick={update}>
            Update
          </button>
        </>
      );
    case "updating":
      return <span className="plugin-status">Cloning and building…</span>;
    case "failed":
      return (
        <>
          <pre className="plugin-output">{updating.problem}</pre>
          <button type="button" data-hint={hints.checkPluginUpdates} onClick={check}>
            Check again
          </button>
        </>
      );
  }
}

function SettingsOf({ settings }: { settings: SettingsOfPlugin }) {
  return (
    <span className="plugin-settings">
      {settings.settings.map((setting) => (
        <label key={setting.id} data-hint={setting.hint}>
          {setting.label}
          <select value={settingValue(settings, setting.id)} onChange={(event) => choosePluginSetting(settings.plugin, setting.id, event.target.value)}>
            {setting.choices.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </span>
  );
}

function PluginRow({ plugin, official, found }: { plugin: PluginInfo; official?: CatalogPlugin; found: PluginNews | undefined }) {
  const settings = usePluginSettings().find(({ plugin: name }) => name === plugin.name);
  const [problem, setProblem] = useState<string | null>(null);
  const title = plugin.title ?? plugin.folder;
  const linked = plugin.source.kind === "linked";
  const remove = async () => setProblem(await changePlugins((requestId) => ({ type: "plugins.remove", requestId, folder: plugin.folder })));
  return (
    <li className={plugin.problem ? "failed" : undefined}>
      <span className="plugin-title">{title}</span>
      {plugin.name && <span className="plugin-name">{plugin.name}</span>}
      {plugin.version && <span className="plugin-version">{plugin.version}</span>}
      {official && (
        <span className="plugin-official" data-hint={hints.officialPlugin}>
          Official
        </span>
      )}
      {plugin.waitsForRestart && <span className="plugin-waits">used from the next start</span>}
      {official && <span className="plugin-description">{official.description}</span>}
      <span className="plugin-source">{sourceLine(plugin.source)}</span>
      {plugin.problem && <span className="plugin-problem">Didn't load: {plugin.problem}</span>}
      {settings && settings.settings.length > 0 && <SettingsOf settings={settings} />}
      {plugin.source.kind !== "shipped" && (
        <span className="plugin-actions">
          {plugin.source.kind === "git" && <PluginUpdate key={plugin.source.commit} plugin={plugin} found={found} />}
          <ConfirmButton
            className="danger"
            label={`Remove ${title}`}
            armedText={linked ? "Remove the link?" : "Remove?"}
            armedHint={linked ? hints.unlinkPluginArmed : hints.removePluginArmed}
            onConfirm={remove}
          >
            Remove
          </ConfirmButton>
        </span>
      )}
      {problem && <pre className="plugin-output">{problem}</pre>}
    </li>
  );
}

function OfficialPluginToInstall({ plugin }: { plugin: CatalogPlugin & { repo: string } }) {
  const [installing, setInstalling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const install = async () => {
    setInstalling(true);
    setProblem(await changePlugins((requestId) => ({ type: "plugins.add", requestId, url: plugin.repo, branch: plugin.branch ?? null })));
    setInstalling(false);
  };
  return (
    <li>
      <span className="plugin-title">{plugin.title}</span>
      <span className="plugin-name">{plugin.name}</span>
      <span className="plugin-description">{plugin.description}</span>
      <span className="plugin-actions">
        <button type="button" data-hint={hints.installOfficialPlugin} disabled={installing} onClick={install}>
          {installing ? "Cloning and building…" : "Install"}
        </button>
      </span>
      {problem && <pre className="plugin-output">{problem}</pre>}
    </li>
  );
}

const toInstall = (official: CatalogPlugin[], installed: PluginInfo[]) =>
  official.filter((plugin): plugin is CatalogPlugin & { repo: string } => plugin.repo !== undefined && !installed.some(({ name }) => name === plugin.name));

function AddPlugin() {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    setProblem(null);
    const problem = await changePlugins((requestId) => ({ type: "plugins.add", requestId, url, branch: branch.trim() || null }));
    setAdding(false);
    setProblem(problem);
    if (!problem) {
      setUrl("");
      setBranch("");
    }
  };
  return (
    <form className="plugin-add" aria-label="Add a plugin" onSubmit={add}>
      <input aria-label="Git URL or path" placeholder="Git URL or path of the plugin's repo" value={url} disabled={adding} onChange={(event) => setUrl(event.target.value)} />
      <input aria-label="Branch" placeholder="Branch (optional)" value={branch} disabled={adding} onChange={(event) => setBranch(event.target.value)} />
      <button type="submit" data-hint={hints.addPlugin} disabled={adding || !url.trim()}>
        {adding ? "Cloning and building…" : "Add"}
      </button>
      {problem && <pre className="plugin-output">{problem}</pre>}
    </form>
  );
}

/** Asked for again whenever the page reconnects, as it does after a restart. */
function usePluginsListed() {
  const [listed, setListed] = useState<PluginsListed | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(connection.status);
  useEffect(() => connection.onStatus(setStatus), []);
  useEffect(
    () =>
      connection.onMessage((message) => {
        if (message.type === "plugins.listed") setListed(message);
      }),
    [],
  );
  useEffect(() => {
    if (status === "open") connection.send({ type: "plugins.list" });
  }, [status]);
  return listed;
}

/** The news Mirador found for the plugin: none once it was updated past the commit it was found from. */
function newsFor(plugin: PluginInfo, pluginUpdates: FoundUpdate[]): PluginNews | undefined {
  const found = pluginUpdates.find(({ folder }) => folder === plugin.folder);
  return found && plugin.source.kind === "git" && plugin.source.commit === found.from ? found : undefined;
}

/** Updates every plugin with new commits, one after the other, and stops at the first that fails. */
function UpdateAll({ updates }: { updates: FoundUpdate[] }) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const updateAll = async () => {
    setProblem(null);
    for (const { folder, title } of updates) {
      setUpdating(title);
      const failed = await changePlugins((requestId) => ({ type: "plugins.update", requestId, folder }));
      if (failed) {
        setProblem(`${title}: ${failed}`);
        break;
      }
    }
    setUpdating(null);
  };
  return (
    <div className="plugin-update-all">
      {updating ? (
        <span className="plugin-status">Updating {updating}…</span>
      ) : (
        <button type="button" data-hint={hints.updateAllPlugins} onClick={updateAll}>
          Update all ({updates.length})
        </button>
      )}
      {problem && <pre className="plugin-output">{problem}</pre>}
    </div>
  );
}

export function PluginSettings({ pluginUpdates }: { pluginUpdates: FoundUpdate[] }) {
  const listed = usePluginsListed();
  const waiting = pluginUpdates.filter(({ folder }) => listed?.plugins.some((plugin) => plugin.folder === folder && newsFor(plugin, pluginUpdates)));
  return (
    <>
      <h3>Plugins</h3>
      <p className="hint">
        A plugin brings an app: a document that you and the agent change together in the canvas. Plugins are the ones Mirador comes with and the
        folders in {listed ? <code>{listed.folder}</code> : "Mirador's plugins folder"}, and load when Mirador starts.
      </p>
      {listed?.restartNeeded && (
        <p className="restart-needed">
          Mirador uses the changed plugins from its next start.
          <button type="button" data-hint={hints.restartHost} onClick={() => connection.send({ type: "host.restart" })}>
            Restart host
          </button>
        </p>
      )}
      {waiting.length > 0 && <UpdateAll updates={waiting} />}
      <ul className="plugin-list" aria-label="Plugins">
        {listed?.plugins.map((plugin) => (
          <PluginRow
            key={`${plugin.source.kind === "shipped" ? "shipped" : "installed"}/${plugin.folder}`}
            plugin={plugin}
            official={listed.official?.find(({ name }) => name === plugin.name)}
            found={newsFor(plugin, pluginUpdates)}
          />
        ))}
        {listed?.plugins.length === 0 && <li className="plugin-none">No plugin is installed.</li>}
      </ul>
      {listed && toInstall(listed.official ?? [], listed.plugins).length > 0 && (
        <>
          <h3>More official plugins</h3>
          <p className="hint">Made for Mirador. An agent recommends one when it would help, and installs it only when you say so.</p>
          <ul className="plugin-list" aria-label="More official plugins">
            {toInstall(listed.official ?? [], listed.plugins).map((plugin) => (
              <OfficialPluginToInstall key={plugin.name} plugin={plugin} />
            ))}
          </ul>
        </>
      )}
      <h3>Add a plugin from a git repo</h3>
      <p className="hint">
        Its code runs inside Mirador with your permissions, and adding it runs the build command its plugin.json names. Add only repos you trust. A
        plugin stays on the commit it was added at until you update it.
      </p>
      <AddPlugin />
    </>
  );
}
