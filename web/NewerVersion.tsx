import { useState } from "react";
import type { DesktopUpdate } from "../shared/desktop-menu.ts";
import { newerVersionKey, newerVersionLabel, type NewerVersion } from "../shared/newer-version.ts";
import { checkForUpdate, restartToUpdate, useDesktopUpdate } from "./desktop-bridge.ts";
import { hints } from "./hints.ts";

const DISMISSED_KEY = "mirador-newer-version-dismissed";
const READY_UPDATE_DISMISSED_KEY = "mirador-ready-update-dismissed";

function storedDismissal(storageKey: string) {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function useDismissal(storageKey: string) {
  const [dismissed, setDismissed] = useState(() => storedDismissal(storageKey));
  const dismiss = (key: string) => {
    try {
      localStorage.setItem(storageKey, key);
    } catch {}
    setDismissed(key);
  };
  return [dismissed, dismiss] as const;
}

type ReadyUpdate = Extract<DesktopUpdate, { stage: "ready" }>;

const readyIn = (desktopUpdate: DesktopUpdate | null) => (desktopUpdate?.stage === "ready" ? desktopUpdate : null);

/** The desktop app's update ready to install is the release it was downloaded from, so it takes that sign's place. */
const notReadyYet = (newerVersion: NewerVersion | null, desktopUpdate: DesktopUpdate | null) =>
  readyIn(desktopUpdate) && newerVersion?.kind === "release" ? null : newerVersion;

function newerVersionSentence(newerVersion: NewerVersion, desktopUpdate: DesktopUpdate | null) {
  const blockedBy = newerVersion.kind === "release" && desktopUpdate?.stage === "blocked" ? `: ${desktopUpdate.blockedBy}` : "";
  return `${newerVersionLabel(newerVersion)}${blockedBy}.`;
}

/**
 * The desktop app that updates itself downloads a release, and is only asked to look again; until it has said whether it
 * does, there is nothing to offer. A pulled checkout needs no word about restarting: the host offers that itself.
 */
function NextStep({ newerVersion, desktopUpdate }: { newerVersion: NewerVersion; desktopUpdate: DesktopUpdate | null }) {
  if (newerVersion.kind === "checkout") return <span>Pull them to update.</span>;
  if (!desktopUpdate) return null;
  if (desktopUpdate.stage === "downloading") return <span>Downloading…</span>;
  if (desktopUpdate.stage === "idle")
    return (
      <button type="button" onClick={checkForUpdate}>
        Download
      </button>
    );
  return (
    <a href={newerVersion.url} target="_blank" rel="noreferrer">
      Download
    </a>
  );
}

function RestartToUpdate() {
  return (
    <button type="button" onClick={restartToUpdate}>
      Restart to update
    </button>
  );
}

function ReadyUpdateBanner({ readyUpdate }: { readyUpdate: ReadyUpdate }) {
  const [dismissed, dismiss] = useDismissal(READY_UPDATE_DISMISSED_KEY);
  if (dismissed === readyUpdate.version) return null;
  return (
    <div className="banner newer-version">
      <span>Mirador {readyUpdate.version} is ready.</span>
      <RestartToUpdate />
      <button type="button" data-hint={hints.dismissNewerVersion} onClick={() => dismiss(readyUpdate.version)}>
        Dismiss
      </button>
    </div>
  );
}

function NewerVersionSign({ newerVersion, desktopUpdate }: { newerVersion: NewerVersion; desktopUpdate: DesktopUpdate | null }) {
  const [dismissed, dismiss] = useDismissal(DISMISSED_KEY);
  if (dismissed === newerVersionKey(newerVersion)) return null;
  return (
    <div className="banner newer-version">
      <span>{newerVersionSentence(newerVersion, desktopUpdate)}</span>
      <NextStep newerVersion={newerVersion} desktopUpdate={desktopUpdate} />
      <button type="button" data-hint={hints.dismissNewerVersion} onClick={() => dismiss(newerVersionKey(newerVersion))}>
        Dismiss
      </button>
    </div>
  );
}

export function NewerVersionBanner({ newerVersion }: { newerVersion: NewerVersion | null }) {
  const desktopUpdate = useDesktopUpdate();
  const readyUpdate = readyIn(desktopUpdate);
  const outThere = notReadyYet(newerVersion, desktopUpdate);
  return (
    <>
      {readyUpdate && <ReadyUpdateBanner readyUpdate={readyUpdate} />}
      {outThere && <NewerVersionSign newerVersion={outThere} desktopUpdate={desktopUpdate} />}
    </>
  );
}

export function NewerVersionNote({ newerVersion }: { newerVersion: NewerVersion | null }) {
  const desktopUpdate = useDesktopUpdate();
  const readyUpdate = readyIn(desktopUpdate);
  const outThere = notReadyYet(newerVersion, desktopUpdate);
  return (
    <>
      {readyUpdate && (
        <p className="hint newer-version">
          Mirador {readyUpdate.version} is ready. <RestartToUpdate />
        </p>
      )}
      {outThere && (
        <p className="hint newer-version">
          {newerVersionSentence(outThere, desktopUpdate)} <NextStep newerVersion={outThere} desktopUpdate={desktopUpdate} />
        </p>
      )}
    </>
  );
}
