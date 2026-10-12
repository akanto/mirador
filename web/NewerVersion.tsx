import { useState } from "react";
import { newerVersionKey, newerVersionLabel, type NewerVersion } from "../shared/newer-version.ts";
import { hints } from "./hints.ts";

const DISMISSED_KEY = "mirador-newer-version-dismissed";

function storedDismissal() {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function useDismissal() {
  const [dismissed, setDismissed] = useState(storedDismissal);
  const dismiss = (key: string) => {
    try {
      localStorage.setItem(DISMISSED_KEY, key);
    } catch {}
    setDismissed(key);
  };
  return [dismissed, dismiss] as const;
}

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

export function NewerVersionBanner({ newerVersion }: { newerVersion: NewerVersion | null }) {
  const [dismissed, dismiss] = useDismissal();
  if (!newerVersion || dismissed === newerVersionKey(newerVersion)) return null;
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

export function NewerVersionNote({ newerVersion }: { newerVersion: NewerVersion | null }) {
  if (!newerVersion) return null;
  return (
    <p className="hint newer-version">
      {newerVersionLabel(newerVersion)}. <NextStep newerVersion={newerVersion} />
    </p>
  );
}
