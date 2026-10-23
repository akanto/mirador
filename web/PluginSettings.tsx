import { useEffect, useState } from "react";
import type { PluginInfo, PluginSource } from "../shared/apps.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { connection, type ConnectionStatus } from "./connection.ts";

type PluginsListed = Extract<ServerMessage, { type: "plugins.listed" }>;

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

function PluginRow({ plugin }: { plugin: PluginInfo }) {
  return (
    <li className={plugin.problem ? "failed" : undefined}>
      <span className="plugin-title">{plugin.title ?? plugin.folder}</span>
      {plugin.name && <span className="plugin-name">{plugin.name}</span>}
      <span className="plugin-source">{sourceLine(plugin.source)}</span>
      {plugin.problem && <span className="plugin-problem">Didn't load: {plugin.problem}</span>}
    </li>
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
      <ul className="plugin-list" aria-label="Plugins">
        {listed?.plugins.map((plugin) => <PluginRow key={plugin.folder} plugin={plugin} />)}
        {listed?.plugins.length === 0 && <li className="plugin-none">No plugin is installed.</li>}
      </ul>
    </>
  );
}
