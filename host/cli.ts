import { loadConfig } from "./config.ts";
import { DeviceService } from "./devices.ts";
import { Store } from "./store.ts";
import { inviteLink } from "../shared/machines.ts";

const usage = `usage: mirador <command>

  invite    Make a one-time code another browser or app joins this Mirador with`;

/** Makes an invite on this machine, for the first device to join it; joined devices invite more from Settings → Devices. */
function invite() {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const { code, expiresAt } = new DeviceService(store).invite();
  const publicOrigin = config.publicOrigin ?? store.rememberedPublicAddress()?.origin ?? null;
  store.close();

  const minutesLeft = Math.round((expiresAt - Date.now()) / 60_000);
  console.log(`Invite code: ${code} (works once, for ${minutesLeft} minutes)`);
  if (publicOrigin) console.log(`Open it on the device that joins: ${inviteLink(publicOrigin, code)}`);
  else console.log("Type it where the machine asks for an invite code. To get a link, give this machine its address in Settings → Devices.");
}

const commands = new Map([["invite", invite]]);
const asksForHelp = (command: string | undefined) => command === undefined || ["help", "--help", "-h"].includes(command);

const [command] = process.argv.slice(2);
const run = command === undefined ? undefined : commands.get(command);
if (run) run();
else if (asksForHelp(command)) console.log(usage);
else {
  console.error(`mirador: unknown command "${command}"\n\n${usage}`);
  process.exitCode = 2;
}
