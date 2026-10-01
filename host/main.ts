import { serveCanvasAssets } from "./canvas/assets.ts";
import { CanvasMcpEndpoints } from "./canvas/mcp.ts";
import { CanvasService } from "./canvas/service.ts";
import { loadConfig } from "./config.ts";
import { ConversationService } from "./conversations.ts";
import { Hub } from "./hub.ts";
import { NotifierMute } from "./notifier.ts";
import { ProfileService } from "./profiles.ts";
import { startServer } from "./server.ts";
import { StatuslineService } from "./statusline.ts";
import { Store } from "./store.ts";
import { TerminalSessionWatcher } from "./terminal-sessions.ts";

const config = loadConfig();
const store = new Store(config.databasePath);
const hub = new Hub();
const conversations = new ConversationService(store, hub, config, new NotifierMute(config.notifierDir));
const canvas = new CanvasService(store, hub, conversations);
const mcp = new CanvasMcpEndpoints(canvas, conversations, config.canvasAssetsOrigin);
const assetsServer = serveCanvasAssets(config.canvasAssetsPort);
const profiles = new ProfileService(store, hub, conversations);
const statusline = new StatuslineService(store, conversations, config.runsUserStatusLine);
const server = startServer({ config, store, hub, conversations, canvas, mcp, profiles, statusline });
const terminalSessions = new TerminalSessionWatcher(
  () => conversations.claudeConfigDirs(),
  (activityBySession) => conversations.showTerminalActivity(activityBySession),
);
terminalSessions.start();

console.log(`visualized-sessions is running. Open:\n\n  ${config.appOrigin}/auth?token=${config.browserToken}\n`);
console.log(`data: ${config.dataDir}  agent logs: ${config.dataDir}/logs`);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  terminalSessions.stop();
  conversations.shutdown();
  server.stop(true);
  assetsServer.stop(true);
  store.close();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.log(`${new Date().toISOString()} received ${signal}, stopping`);
    shutdown();
  });
}
process.on("exit", () => conversations.shutdown());
