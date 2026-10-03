import { dirname, join } from "node:path";
import { serveCanvasAssets } from "./canvas/assets.ts";
import { CanvasMcpEndpoints } from "./canvas/mcp.ts";
import { CanvasService } from "./canvas/service.ts";
import { loadConfig } from "./config.ts";
import { ConversationService } from "./conversations.ts";
import { DeviceService } from "./devices.ts";
import { ConversationSearch } from "./search.ts";
import { Hub } from "./hub.ts";
import { ImageStore } from "./images.ts";
import { NotifierMute } from "./notifier.ts";
import { ProfileService } from "./profiles.ts";
import { HostRestart, takeTurnsStoppedForRestart } from "./restart.ts";
import { startServer } from "./server.ts";
import { SourceWatcher } from "./source-watcher.ts";
import { StatuslineService } from "./statusline.ts";
import { SystemNotifications } from "./system-notifications.ts";
import { Store } from "./store.ts";
import { TerminalSessionWatcher } from "./terminal-sessions.ts";
import { TerminalService } from "./terminals.ts";

const config = loadConfig();
const store = new Store(config.databasePath);
const hub = new Hub();
const images = new ImageStore(join(config.dataDir, "images"));
const notifications = new SystemNotifications(store, hub);
const conversations = new ConversationService(store, hub, config, new NotifierMute(config.notifierDir), images, notifications);
const canvas = new CanvasService(store, hub, conversations, notifications);
const mcp = new CanvasMcpEndpoints(canvas, conversations, config.canvasAssetsOrigin);
const assetsServer = serveCanvasAssets(config.canvasAssetsPort);
const profiles = new ProfileService(store, hub, conversations);
const statusline = new StatuslineService(store, conversations, config.runsUserStatusLine);
const terminals = new TerminalService(hub, (workspaceId) => store.findWorkspace(workspaceId)?.path);
const restart = new HostRestart(hub, conversations, config.dataDir, stopServices);
const devices = new DeviceService(store);
const search = new ConversationSearch(store);
const { server, rebuildUi } = startServer({ config, store, hub, conversations, canvas, mcp, profiles, statusline, terminals, images, restart, devices, search });
const sourceWatcher = new SourceWatcher(dirname(import.meta.dir), { uiEdited: rebuildUi, hostEdited: () => restart.hostCodeEdited() });
sourceWatcher.start();
conversations.resumeAfterRestart(takeTurnsStoppedForRestart(config.dataDir));
const terminalSessions = new TerminalSessionWatcher(
  () => conversations.claudeConfigDirs(),
  (activityBySession) => conversations.showTerminalActivity(activityBySession),
);
terminalSessions.start();

console.log(`Mirador is running. Open:\n\n  ${config.appOrigin}/auth?token=${config.browserToken}\n`);
console.log(`data: ${config.dataDir}  agent logs: ${config.dataDir}/logs`);

async function stopServices() {
  terminalSessions.stop();
  sourceWatcher.stop();
  terminals.shutdown();
  const agentsExited = conversations.shutdown();
  server.stop(true);
  assetsServer.stop(true);
  store.close();
  await agentsExited;
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  void stopServices();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.log(`${new Date().toISOString()} received ${signal}, stopping`);
    shutdown();
  });
}
process.on("exit", () => conversations.shutdown());
