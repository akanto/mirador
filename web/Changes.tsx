import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { changeScopes, type ChangedFile, type ChangeList, type ChangeScope, type ChangesBase, type FileChanges } from "../shared/changes.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { firstChangedLine } from "./changes.ts";
import { connection } from "./connection.ts";
import { DiffStyleChoice, diffStyle, EditedFile } from "./EditApproval.tsx";
import { hints } from "./hints.ts";
import { storedChoice } from "./stored-choice.ts";
import { withHomeAsTilde } from "./workspace-folder.ts";

const scopeLabels: Record<ChangeScope, string> = { turn: "This turn", uncommitted: "Uncommitted", session: "This session" };
const changesScope = storedChoice<ChangeScope>("mirador-changes-scope", changeScopes, "turn");
const statusLetters: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D" };

const listNotes: Partial<Record<ChangesBase, string>> = {
  session: "The files the agent changed with its edit tools in this conversation. Files a script wrote are not listed.",
  "turn-file-times": "This folder is not a git repository, so the list holds the files written since this turn began, and the agent's edits. Deleted files and earlier versions are not known.",
  "not-a-repository": "This folder is not a git repository, so the list holds only the files the agent edited.",
  "turn-not-kept": "The files from this turn's start are no longer kept, so the list holds only the files the agent edited.",
};
const nothingChanged = (list: ChangeList) =>
  list.base === "no-turn" ? "Files the agent changes in this conversation show here." : list.scope === "turn" ? "No file changed in this turn." : list.scope === "session" ? "The agent has not changed a file in this conversation." : "No uncommitted changes.";

function changesRequest<T>(send: (requestId: string) => ClientMessage, picked: (message: ServerMessage) => T | undefined) {
  return connection.sendAndAwait(send, (message, requestId) => {
    if (message.type === "changes.failed" && message.requestId === requestId) throw new Error(message.message);
    return "requestId" in message && message.requestId === requestId ? picked(message) : undefined;
  });
}

const listChanges = (conversationId: string, scope: ChangeScope) =>
  changesRequest(
    (requestId) => ({ type: "changes.list", requestId, conversationId, scope }),
    (message) => (message.type === "changes.listed" ? message.list : undefined),
  );

const fileChanges = (conversationId: string, scope: ChangeScope, path: string) =>
  changesRequest(
    (requestId) => ({ type: "changes.diff", requestId, conversationId, scope, path }),
    (message) => (message.type === "changes.diffed" ? message.changes : undefined),
  );

type Loaded<T> = { value: T } | { error: string };

const LOADS_KEPT = 100;
const keptLoads = new Map<string, Loaded<unknown>>();
const selectedPaths = new Map<string, string | null>();

function keepLoad(key: string, loaded: Loaded<unknown>) {
  keptLoads.delete(key);
  keptLoads.set(key, loaded);
  if (keptLoads.size > LOADS_KEPT) keptLoads.delete(keptLoads.keys().next().value!);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What `load` answered last for `key`, kept while the app runs, so the view shows it at once when it opens again.
 * It loads again when it opens and each time `trigger` changes, one request at a time, and shows the answer only
 * when it differs from the kept one.
 */
function useKeptLoad<T>(key: string, load: () => Promise<T>, trigger: string): Loaded<T> | null {
  const [, showNewAnswer] = useReducer((answers: number) => answers + 1, 0);
  const newest = useRef({ key, load });
  newest.current = { key, load };
  const running = useRef(false);
  const wantedAgain = useRef(false);
  useEffect(() => {
    if (running.current) {
      wantedAgain.current = true;
      return;
    }
    running.current = true;
    (async () => {
      do {
        wantedAgain.current = false;
        const { key, load } = newest.current;
        const answer: Loaded<unknown> = await load().then(
          (value) => ({ value }),
          (error) => ({ error: errorText(error) }),
        );
        if (JSON.stringify(answer) === JSON.stringify(keptLoads.get(key))) continue;
        keepLoad(key, answer);
        showNewAnswer();
      } while (wantedAgain.current);
      running.current = false;
    })();
  }, [key, trigger]);
  return (keptLoads.get(key) as Loaded<T> | undefined) ?? null;
}

function FileRow({ file, homeDir, selected, onSelect, children }: { file: ChangedFile; homeDir: string; selected: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <li>
      <button type="button" className={`changed-file status-${file.status} ${selected ? "selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
        <span className="change-status" title={file.status}>
          {statusLetters[file.status]}
        </span>
        <span className="changed-path">{withHomeAsTilde(file.path, homeDir)}</span>
        {file.added !== null && (
          <span className="edit-counts">
            <span className="added-count">+{file.added}</span> <span className="removed-count">−{file.removed}</span>
          </span>
        )}
        {file.byAgent && (
          <span className="by-agent" data-hint={hints.changesByAgent}>
            ● agent
          </span>
        )}
      </button>
      {selected && children}
    </li>
  );
}

/** A section of the list; the selected file's line changes open under its row. */
function FileSection({
  title,
  files,
  selectedPath,
  onSelect,
  selectedFile,
  homeDir,
}: {
  title: string;
  files: ChangedFile[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  selectedFile: ReactNode;
  homeDir: string;
}) {
  if (files.length === 0) return null;
  return (
    <section className="changes-section" aria-label={title}>
      <h3>{title}</h3>
      <ul>
        {files.map((file) => (
          <FileRow key={file.path} file={file} homeDir={homeDir} selected={file.path === selectedPath} onSelect={() => onSelect(file.path)}>
            {selectedFile}
          </FileRow>
        ))}
      </ul>
    </section>
  );
}

function SelectedFile({ conversationId, file, loaded, homeDir }: { conversationId: string; file: ChangedFile; loaded: Loaded<FileChanges | null> | null; homeDir: string }) {
  const style = diffStyle.use();
  const changes = loaded && "value" in loaded && loaded.value?.path === file.path ? loaded.value : null;
  return (
    <div className="changes-diff">
      <div className="edit-approval-bar">
        <span className="spacer" />
        {changes && file.status !== "deleted" && (
          <button
            type="button"
            className="link"
            data-hint={hints.changesOpenInIdea}
            onClick={() => connection.send({ type: "changes.open-in-editor", conversationId, path: file.path, line: firstChangedLine(changes) })}
          >
            Open in IDEA
          </button>
        )}
        <DiffStyleChoice style={style} />
      </div>
      {loaded && "error" in loaded && <p className="review-empty">{loaded.error}</p>}
      {changes?.source === "agent" && <p className="hint">The agent's own edits to this file, one by one, without line numbers.</p>}
      {changes && changes.diffs.length === 0 && <p className="review-empty">No line changes.</p>}
      {changes?.diffs.map((diff, index) => (
        <EditedFile key={index} edit={{ ...diff, path: withHomeAsTilde(diff.path, homeDir) }} style={style} unlocatedHint={null} />
      ))}
    </div>
  );
}

/** The files this turn, or the uncommitted work, changed; the agent's own edits are marked, and a file's line changes open under its row. */
export function ChangesView({ conversationId, refreshPoint, homeDir }: { conversationId: string; refreshPoint: number; homeDir: string }) {
  const scope = changesScope.use();
  const [refreshes, setRefreshes] = useState(0);
  const reloadWhen = `${refreshPoint} ${refreshes}`;
  const [selectedPath, setSelectedPath] = useState(selectedPaths.get(conversationId) ?? null);
  const loadedList = useKeptLoad(`list ${conversationId} ${scope}`, () => listChanges(conversationId, scope), reloadWhen);
  const list = loadedList && "value" in loadedList ? loadedList.value : null;
  const files = list ? [...list.project, ...list.outside] : [];
  const selected = files.find(({ path }) => path === selectedPath) ?? null;
  const loadedDiff = useKeptLoad<FileChanges | null>(
    `diff ${conversationId} ${scope} ${selected?.path}`,
    () => (selected ? fileChanges(conversationId, scope, selected.path) : Promise.resolve(null)),
    reloadWhen,
  );
  const toggle = (path: string) => {
    const next = path === selectedPath ? null : path;
    selectedPaths.set(conversationId, next);
    setSelectedPath(next);
  };
  const selectedFile = selected && <SelectedFile conversationId={conversationId} file={selected} loaded={loadedDiff} homeDir={homeDir} />;

  return (
    <div className="changes">
      <div className="changes-bar">
        <div className="diff-style" role="group" aria-label="Changes since">
          {changeScopes.map((each) => (
            <button key={each} type="button" className={scope === each ? "on" : ""} aria-pressed={scope === each} data-hint={hints.changesScope[each]} onClick={() => changesScope.set(each)}>
              {scopeLabels[each]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className="link" data-hint={hints.changesRefresh} onClick={() => setRefreshes((count) => count + 1)}>
          Refresh
        </button>
      </div>
      {loadedList && "error" in loadedList ? <p className="review-empty">{loadedList.error}</p> : !list && <p className="changes-none">Loading…</p>}
      {list && listNotes[list.base] && <p className="hint">{listNotes[list.base]}</p>}
      {list?.filesCheckedAtMost !== undefined && (
        <p className="review-empty">This folder holds more than {list.filesCheckedAtMost.toLocaleString("en")} files, so only that many were checked and some changed files may be missing.</p>
      )}
      {list && files.length === 0 && <p className="changes-none">{nothingChanged(list)}</p>}
      {list && (
        <>
          <FileSection title="Project" files={list.project} selectedPath={selectedPath} onSelect={toggle} selectedFile={selectedFile} homeDir={homeDir} />
          <FileSection title="Outside the project" files={list.outside} selectedPath={selectedPath} onSelect={toggle} selectedFile={selectedFile} homeDir={homeDir} />
        </>
      )}
    </div>
  );
}
