import { dirname, join } from "node:path";
import { serveCanvasAssets } from "./canvas/assets.ts";
import { authorityFingerprint, namesToCover, servingCertificate } from "./certificates.ts";
import { CanvasMcpEndpoints } from "./canvas/mcp.ts";
import { CanvasService } from "./canvas/service.ts";
import { loadConfig } from "./config.ts";
import { ConversationService } from "./conversations.ts";
import { DeviceService } from "./devices.ts";
import { JoinRequestService } from "./join-requests.ts";
import { MachineRelays } from "./machine-relays.ts";
import { MachineWatch } from "./machine-watch.ts";
import { ConversationSearch } from "./search.ts";
import { signedInWith } from "./sign-in.ts";
import { SignInCodes, signInLink } from "./sign-in-codes.ts";
import { Hub } from "./hub.ts";
import { ImageStore } from "./images.ts";
import { NotifierMute } from "./notifier.ts";
import { installedHarnesses } from "./acp/harnesses.ts";
import { giveEveryWorkspaceAProfile, moveProfilelessOntoProfiles, ProfileService } from "./profiles.ts";
import { HostRestart, stoppedWithinTimeout, takeTurnsStoppedForRestart } from "./restart.ts";
import { DesktopAppCheck } from "./desktop-app-check.ts";
import { NewerVersionWatcher, newerVersionLookup } from "./newer-version.ts";
import { desktopAppCode } from "../shared/desktop-app-code.ts";
import { startServer } from "./server.ts";
import { SourceWatcher } from "./source-watcher.ts";
import { StatuslineService } from "./statusline.ts";
import { SystemNotifications } from "./system-notifications.ts";
import { Store } from "./store.ts";
import { TerminalSessionWatcher } from "./terminal-sessions.ts";
import { TerminalService } from "./terminals.ts";

const config = loadConfig();
const { network } = config.reachability;
const certificate = network && servingCertificate(config.dataDir, namesToCover(config.publicOrigin && new URL(config.publicOrigin).hostname), network.ownCertificate);
const store = new Store(config.databasePath);
moveProfilelessOntoProfiles(store, installedHarnesses(store.claudeProgramSetting()));
giveEveryWorkspaceAProfile(store);
store.rememberPublicAddress(config.publicOrigin ? { origin: config.publicOrigin, canvasOrigin: config.canvasAssetsOrigin } : null);
const ownAuthorityFingerprint = certificate?.authority ? authorityFingerprint(certificate.authority) : null;
store.rememberAuthorityFingerprint(ownAuthorityFingerprint);
const hub = new Hub();
const images = new ImageStore(join(config.dataDir, "images"));
const notifications = new SystemNotifications(store, hub);
const notifierMute = new NotifierMute(config.notifierDir, join(config.dataDir, "notifier-muted.json"));
notifierMute.unmuteSessionsOfEarlierRuns();
const conversations = new ConversationService(store, hub, config, notifierMute, images, notifications);
const canvas = new CanvasService(store, hub, conversations, notifications);
const mcp = new CanvasMcpEndpoints(canvas, conversations, config.canvasAssetsOrigin);
const assetsServer = serveCanvasAssets(config.canvasAssetsPort);
const networkAssetsServer = network && certificate && serveCanvasAssets(network.canvasPort, certificate);
const profiles = new ProfileService(store, hub, conversations);
const statusline = new StatuslineService(store, conversations, config.runsUserStatusLine);
const terminals = new TerminalService(hub, store);
const restart = new HostRestart(hub, conversations, config.dataDir, stopServices);
const sourceDir = dirname(import.meta.dir);
const desktopApp = new DesktopAppCheck(
  () => desktopAppCode(join(sourceDir, "desktop")),
  (outdated) => hub.broadcast({ type: "desktop-app.outdated", outdated }),
);
const newerVersion = new NewerVersionWatcher(newerVersionLookup(sourceDir, config.latestReleaseUrl), (found) => hub.announceNewerVersion(found));
const devices = new DeviceService(store);
const joinRequests = new JoinRequestService(store, devices, ownAuthorityFingerprint);
const signInCodes = new SignInCodes(store);
const search = new ConversationSearch(store);
const signedIn = signedInWith(config.browserToken, devices);
const watch = new MachineWatch(
  store,
  (status) => hub.broadcast({ type: "machine.status", status }),
  (notification) => hub.notifyThisComputer(notification),
  machineSignedOut,
);
const relays = new MachineRelays(
  store,
  config.relayPorts,
  `http://127.0.0.1:${config.canvasAssetsPort}`,
  (request) => signedIn(request) !== null,
  (machineId) => {
    hub.broadcast({ type: "machines.changed", machines: store.listMachines() });
    watch.start(machineId);
  },
  machineSignedOut,
);
relays.startAll();
watch.startAll();
const server = startServer({ config, store, hub, conversations, canvas, mcp, profiles, statusline, terminals, images, restart, desktopApp, newerVersion, devices, joinRequests, signInCodes, search, relays, watch, certificate });
const sourceWatcher = new SourceWatcher(sourceDir, {
  uiEdited: () => {
    server.rebuildUi();
    newerVersion.recount();
  },
  hostEdited: () => {
    restart.hostCodeEdited();
    newerVersion.recount();
  },
});
sourceWatcher.start();
if (config.checksForNewerVersion) newerVersion.start();
conversations.resumeAfterRestart(takeTurnsStoppedForRestart(config.dataDir));
const terminalSessions = new TerminalSessionWatcher(
  () => conversations.claudeConfigDirs(),
  (activityBySession) => conversations.showTerminalActivity(activityBySession),
);
terminalSessions.start();

if (process.stdout.isTTY) console.log(`Mirador is running. Open:\n\n  ${signInLink(config.appOrigin, signInCodes.mint())}\n`);
else console.log(`Mirador is running at ${config.appOrigin}. To sign a browser in, open the link mirador sign-in prints.`);
console.log(`data: ${config.dataDir}  agent logs: ${config.dataDir}/logs`);
if (network) console.log(`other devices: ${config.publicOrigin} (HTTPS on port ${network.port} of every network this machine is on)`);

function machineSignedOut(machineId: string) {
  store.forgetMachineDeviceToken(machineId);
  watch.stop(machineId);
  hub.broadcast({ type: "machines.changed", machines: store.listMachines() });
}

async function stopServices() {
  terminalSessions.stop();
  sourceWatcher.stop();
  newerVersion.stop();
  const childrenExited = Promise.all([terminals.shutdown(), conversations.shutdown()]);
  server.stop();
  assetsServer.stop(true);
  networkAssetsServer?.stop(true);
  relays.stopAll();
  watch.stopAll();
  store.close();
  await childrenExited;
}

let stopping = false;
async function shutdown() {
  if (stopping) process.exit(0);
  stopping = true;
  await stoppedWithinTimeout(stopServices).catch((error) => console.error(`${new Date().toISOString()} stopping the services failed:`, error));
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.log(`${new Date().toISOString()} received ${signal}, stopping`);
    shutdown();
  });
}
process.on("exit", () => conversations.shutdown());
