import { useEffect, useState, type FormEvent } from "react";
import type { PluginCommit, PluginInfo, PluginSource } from "../shared/apps.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection, type ConnectionStatus } from "./connection.ts";
import { hints } from "./hints.ts";

type PluginsListed = Extract<ServerMessage, { type: "plugins.listed" }>;

/** Sends a change to the plugins and waits for it: null once done, else what went wrong, git's or the build's output included. */
async function changePlugins(send: (requestId: string) => ClientMessage): Promise<string | null> {
  try {
    return await connection.sendAndAwait(send, (message, requestId) => (message.type === "plugins.changed" && message.requestId === requestId ? message.problem : undefined));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function findCommits(folder: string): Promise<{ commits: PluginCommit[]; problem: string | null }> {
  try {
    return await connection.sendAndAwait(
      (requestId) => ({ type: "plugins.find-commits", requestId, folder }),
      (message, requestId) => (message.type === "plugins.commits-found" && message.requestId === requestId ? message : undefined),
    );
  } catch (error) {
    return { commits: [], problem: error instanceof Error ? error.message : String(error) };
  }
}

function sourceLine(source: PluginSource) {
  switch (source.kind) {
    case "git":
      return [source.remote ?? "no remote", source.branch ?? "no branch", `${source.commit} ${source.subject}`].join(" · ");
    case "linked":
      return `Linked to ${source.target}`;
    case "folder":
      return "A folder put there by hand";
  }
}

type Updating =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "found"; commits: PluginCommit[] }
  | { step: "updating"; commits: PluginCommit[] }
  | { step: "failed"; problem: string };

function PluginUpdate({ plugin }: { plugin: PluginInfo }) {
  const [updating, setUpdating] = useState<Updating>({ step: "idle" });
  const check = async () => {
    setUpdating({ step: "checking" });
    const { commits, problem } = await findCommits(plugin.folder);
    setUpdating(problem ? { step: "failed", problem } : { step: "found", commits });
  };
  const update = async (commits: PluginCommit[]) => {
    setUpdating({ step: "updating", commits });
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
      if (updating.commits.length === 0) {
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
          <ul className="plugin-commits" aria-label={`New commits of ${plugin.title ?? plugin.folder}`}>
            {updating.commits.map(({ commit, subject }) => (
              <li key={commit}>
                <code>{commit}</code> {subject}
              </li>
            ))}
          </ul>
          <button type="button" data-hint={hints.updatePlugin} onClick={() => update(updating.commits)}>
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

function PluginRow({ plugin }: { plugin: PluginInfo }) {
  const [problem, setProblem] = useState<string | null>(null);
  const title = plugin.title ?? plugin.folder;
  const linked = plugin.source.kind === "linked";
  const remove = async () => setProblem(await changePlugins((requestId) => ({ type: "plugins.remove", requestId, folder: plugin.folder })));
  return (
    <li className={plugin.problem ? "failed" : undefined}>
      <span className="plugin-title">{title}</span>
      {plugin.name && <span className="plugin-name">{plugin.name}</span>}
      {plugin.waitsForRestart && <span className="plugin-waits">used from the next start</span>}
      <span className="plugin-source">{sourceLine(plugin.source)}</span>
      {plugin.problem && <span className="plugin-problem">Didn't load: {plugin.problem}</span>}
      <span className="plugin-actions">
        {plugin.source.kind === "git" && <PluginUpdate key={plugin.source.commit} plugin={plugin} />}
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
      {problem && <pre className="plugin-output">{problem}</pre>}
    </li>
  );
}

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

export function PluginSettings() {
  const listed = usePluginsListed();
  return (
    <>
      <h3>Plugins</h3>
      <p className="hint">
        A plugin brings an app: a document that you and the agent change together in the canvas. Plugins are the folders in{" "}
        {listed ? <code>{listed.folder}</code> : "Mirador's plugins folder"}, and load when Mirador starts.
      </p>
      {listed?.restartNeeded && (
        <p className="restart-needed">
          Mirador uses the changed plugins from its next start.
          <button type="button" data-hint={hints.restartHost} onClick={() => connection.send({ type: "host.restart" })}>
            Restart host
          </button>
        </p>
      )}
      <ul className="plugin-list" aria-label="Plugins">
        {listed?.plugins.map((plugin) => <PluginRow key={plugin.folder} plugin={plugin} />)}
        {listed?.plugins.length === 0 && <li className="plugin-none">No plugin is installed.</li>}
      </ul>
      <h3>Add a plugin from a git repo</h3>
      <p className="hint">
        Its code runs inside Mirador with your permissions, and adding it runs the build command its plugin.json names. Add only repos you trust. A
        plugin stays on the commit it was added at until you update it.
      </p>
      <AddPlugin />
    </>
  );
}
