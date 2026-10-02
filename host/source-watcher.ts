import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

type EditListener = "uiEdited" | "hostEdited";

/** The page bundle is built from web/ and shared/; the host process runs host/ and shared/. */
const listenersByDirectory: Record<string, EditListener[]> = { web: ["uiEdited"], shared: ["uiEdited", "hostEdited"], host: ["hostEdited"] };

/** Watches Mirador's own source, so a page reload gets fresh UI code and the page can tell that the host runs old code. */
export class SourceWatcher {
  private watchers: FSWatcher[] = [];

  constructor(
    private readonly sourceDir: string,
    private readonly on: Record<EditListener, () => void>,
  ) {}

  start() {
    this.watchers = Object.entries(listenersByDirectory).map(([directory, listeners]) =>
      watch(join(this.sourceDir, directory), { recursive: true }, () => listeners.forEach((listener) => this.on[listener]())),
    );
  }

  stop() {
    this.watchers.forEach((watcher) => watcher.close());
  }
}
