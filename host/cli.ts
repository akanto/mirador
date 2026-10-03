import { loadConfig } from "./config.ts";
import { DeviceService } from "./devices.ts";
import { JoinRequestService } from "./join-requests.ts";
import { Store } from "./store.ts";
import type { JoinRequest } from "../shared/model.ts";
import { inviteLink } from "../shared/machines.ts";

const usage = `usage: mirador <command>

  invite    Make a one-time code another browser or app joins this Mirador with
  approve   Let in the devices that ask to join this Mirador, by typing the number each shows`;

/** Makes an invite on this machine, for the first device to join it; joined devices invite more from Settings → Devices. */
function invite() {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const { code, expiresAt } = new DeviceService(store).invite();
  const publicOrigin = config.publicOrigin ?? store.rememberedPublicAddress()?.origin ?? null;
  const authorityFingerprint = store.rememberedAuthorityFingerprint();
  store.close();

  console.log(`Invite code: ${code} (works once, for ${minutesLeft(expiresAt)} minutes)`);
  if (publicOrigin) console.log(`Open it on the device that joins: ${inviteLink(publicOrigin, code, authorityFingerprint)}`);
  else console.log("Type it where the machine asks for an invite code. To get a link, give this machine its address in Settings → Devices.");
}

const minutesLeft = (until: number) => Math.max(1, Math.round((until - Date.now()) / 60_000));

function describe({ name, fromAddress, tailscaleUser, expiresAt }: JoinRequest) {
  const signedInAs = tailscaleUser ? `, signed in to Tailscale as ${tailscaleUser}` : "";
  return `${name} asks to join, from ${fromAddress}${signedInAs} (${minutesLeft(expiresAt)} minutes left).`;
}

/** Answers each waiting request in turn, on this machine, e.g. over ssh while no page of it is open anywhere. */
async function approve() {
  const store = new Store(loadConfig().databasePath);
  const requests = new JoinRequestService(store, new DeviceService(store), store.rememberedAuthorityFingerprint());
  const waiting = requests.waiting();
  if (waiting.length === 0) console.log("No device is asking to join this Mirador.");
  for (const request of waiting) {
    console.log(describe(request));
    const answer = prompt("Type the number it shows to approve it, d to deny it, or Enter to leave it waiting:")?.trim();
    if (!answer) console.log("Left waiting.");
    else if (answer.toLowerCase() === "d") {
      requests.deny(request.id);
      console.log("Denied.");
    } else if (await requests.approve(request.id, answer)) console.log(`Approved. ${request.name} gets in when it next checks, within seconds.`);
    else console.log("That is not the number it shows, so its request was denied. It can ask again.");
  }
  store.close();
}

const commands = new Map<string, () => void | Promise<void>>([
  ["invite", invite],
  ["approve", approve],
]);
const asksForHelp = (command: string | undefined) => command === undefined || ["help", "--help", "-h"].includes(command);

const [command] = process.argv.slice(2);
const run = command === undefined ? undefined : commands.get(command);
if (run) await run();
else if (asksForHelp(command)) console.log(usage);
else {
  console.error(`mirador: unknown command "${command}"\n\n${usage}`);
  process.exitCode = 2;
}
