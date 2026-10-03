import { loadConfig } from "./config.ts";
import { DeviceService } from "./devices.ts";
import { Store } from "./store.ts";

/** Makes an invite on this machine, for the first device to join it; joined devices invite more from Settings. */
const config = loadConfig();
const store = new Store(config.databasePath);
const { code, expiresAt } = new DeviceService(store).invite();
store.close();

const minutesLeft = Math.round((expiresAt - Date.now()) / 60_000);
console.log(`Invite code: ${code} (works once, for ${minutesLeft} minutes)`);
if (config.publicOrigin) console.log(`Open it on the device that joins: ${config.publicOrigin}/#/join/${code}`);
else console.log("Type it on the Join screen of this machine's Mirador. (Set MIRADOR_PUBLIC_ORIGIN to get a link.)");
