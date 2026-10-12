import { useState } from "react";
import type { DesktopUpdate } from "../shared/desktop-menu.ts";
import { newerVersionKey, newerVersionLabel, type NewerVersion } from "../shared/newer-version.ts";
import { restartToUpdate, useReadyUpdate } from "./desktop-bridge.ts";
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

/** The desktop app's update ready to install is the release it was downloaded from, so it takes that sign's place. */
const notReadyYet = (newerVersion: NewerVersion | null, readyUpdate: DesktopUpdate | null) => (readyUpdate && newerVersion?.kind === "release" ? null : newerVersion);

/** A pulled checkout needs no word about restarting: the host offers that itself once its code changed. */
function NextStep({ newerVersion }: { newerVersion: NewerVersion }) {
  if (newerVersion.kind === "release")
    return (
      <a href={newerVersion.url} target="_blank" rel="noreferrer">
        Download
      </a>
    );
  return <span>Pull them to update.</span>;
}

function RestartToUpdate() {
  return (
    <button type="button" onClick={restartToUpdate}>
      Restart to update
    </button>
  );
}

function ReadyUpdateBanner({ readyUpdate }: { readyUpdate: DesktopUpdate }) {
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

function NewerVersionSign({ newerVersion }: { newerVersion: NewerVersion }) {
  const [dismissed, dismiss] = useDismissal(DISMISSED_KEY);
  if (dismissed === newerVersionKey(newerVersion)) return null;
  return (
    <div className="banner newer-version">
      <span>{newerVersionLabel(newerVersion)}.</span>
      <NextStep newerVersion={newerVersion} />
      <button type="button" data-hint={hints.dismissNewerVersion} onClick={() => dismiss(newerVersionKey(newerVersion))}>
        Dismiss
      </button>
    </div>
  );
}

export function NewerVersionBanner({ newerVersion }: { newerVersion: NewerVersion | null }) {
  const readyUpdate = useReadyUpdate();
  const outThere = notReadyYet(newerVersion, readyUpdate);
  return (
    <>
      {readyUpdate && <ReadyUpdateBanner readyUpdate={readyUpdate} />}
      {outThere && <NewerVersionSign newerVersion={outThere} />}
    </>
  );
}

export function NewerVersionNote({ newerVersion }: { newerVersion: NewerVersion | null }) {
  const readyUpdate = useReadyUpdate();
  const outThere = notReadyYet(newerVersion, readyUpdate);
  return (
    <>
      {readyUpdate && (
        <p className="hint newer-version">
          Mirador {readyUpdate.version} is ready. <RestartToUpdate />
        </p>
      )}
      {outThere && (
        <p className="hint newer-version">
          {newerVersionLabel(outThere)}. <NextStep newerVersion={outThere} />
        </p>
      )}
    </>
  );
}
