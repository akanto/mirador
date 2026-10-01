import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * claude-notifier skips any session that has a `mute-<sessionId>` marker in its
 * config directory; app-driven sessions get their approvals in the browser instead.
 */
export class NotifierMute {
  constructor(private readonly notifierDir: string | null) {}

  mute(sessionId: string, label: string) {
    if (this.notifierDir) writeFileSync(this.markerPath(sessionId), `${label} (mirador)`);
  }

  unmute(sessionId: string) {
    if (this.notifierDir) rmSync(this.markerPath(sessionId), { force: true });
  }

  private markerPath(sessionId: string) {
    return join(this.notifierDir!, `mute-${sessionId.replace(/[^A-Za-z0-9_-]/g, "-")}`);
  }
}
