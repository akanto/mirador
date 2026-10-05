import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { DeviceService } from "./devices.ts";
import { JoinRequestService } from "./join-requests.ts";
import { SIGN_IN_CODE_LIFETIME_MINUTES, SignInCodes, signInLink } from "./sign-in-codes.ts";
import { Store } from "./store.ts";
import { connectedFrom, deviceStatus, joinedOn } from "../shared/devices.ts";
import type { JoinRequest, ListedDevice } from "../shared/model.ts";
import { describeJob, isContainerName, isPid, isSshHost, type JobWaitRequest } from "../shared/job-waits.ts";
import { inviteLink } from "../shared/machines.ts";

const usage = `usage: mirador <command>

  sign-in    Make a one-time link a browser on this machine signs in to Mirador with
  invite     Make a one-time code another browser or app joins this Mirador with
  approve    Let in the devices that ask to join this Mirador, by typing the number each shows
  devices    List the devices that joined this Mirador, and which are connected now
  when-done  Have Mirador wait for a job an agent left running, then send the agent a message (run it from the agent)`;

const whenDoneUsage = `usage: mirador when-done (--pid <pid> | --container <name>) [--host <user@host>] [--no-resume] [--session <agent session id>] ["<message>"]

  Mirador waits for the process or Docker/Podman container to end, on this machine or, with --host, on another one over ssh.
  Then the message goes to the agent's conversation as your next message, so the agent carries on;
  with --no-resume only you are told. Without a message, it says the job ended.
  Run it from an agent in Mirador: it needs MIRADOR_URL, MIRADOR_SCRIPT_TOKEN and CLAUDE_CODE_SESSION_ID (or --session).`;

/** The host prints a sign-in link only to a terminal, and each link works once, so a new browser needs a new link. */
function signIn() {
  const config = loadConfig();
  const store = new Store(config.databasePath);
  const code = new SignInCodes(store).mint();
  store.close();
  console.log(`Open this link in the browser to sign in (it works once, for ${SIGN_IN_CODE_LIFETIME_MINUTES} minutes):\n\n  ${signInLink(config.appOrigin, code)}\n`);
}

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

/** The running host knows who is connected; without it, the database still knows when each device was last seen. */
async function listDevices() {
  const config = loadConfig();
  const response = await fetch(`${config.appOrigin}/devices`, { headers: { Authorization: `Bearer ${config.browserToken}` } }).catch(() => null);
  if (!response) console.log(`Mirador is not running at ${config.appOrigin}, so no device is connected to it.`);
  else if (!response.ok) console.log(`Mirador at ${config.appOrigin} would not say which devices are connected (${response.status} ${await response.text()}).`);
  const devices = response?.ok ? ((await response.json()) as { devices: ListedDevice[] }).devices : storedDevices(config.databasePath);
  if (devices.length === 0) return console.log("No device has joined this Mirador yet. Let one in with mirador invite.");
  printColumns(devices.map((device) => [device.name, deviceStatus(device), device.connection ? connectedFrom(device.connection) : "", `joined ${joinedOn(device.joinedAt)}`]));
}

function storedDevices(databasePath: string): ListedDevice[] {
  const store = new Store(databasePath);
  const devices = new DeviceService(store).list();
  store.close();
  return devices.map((device) => ({ ...device, connection: null }));
}

/** Lined up, leaving out a column nobody has a value in. */
function printColumns(rows: string[][]) {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const filled = (row: string[]) => row.flatMap((cell, column) => (widths[column] ? [cell.padEnd(widths[column])] : []));
  rows.forEach((row) => console.log(filled(row).join("   ").trimEnd()));
}

function jobWaitRequest(args: string[]): { session: string | undefined; request: JobWaitRequest } {
  const { values, positionals } = parseArgs({
    args,
    options: { pid: { type: "string" }, container: { type: "string" }, host: { type: "string" }, "no-resume": { type: "boolean" }, session: { type: "string" } },
    allowPositionals: true,
  });
  const { pid, container, host = null, session } = values;
  if ((pid === undefined) === (container === undefined)) throw new Error("name the job with either --pid or --container");
  if (pid !== undefined && !isPid(Number(pid))) throw new Error(`"${pid}" is not a process id`);
  if (container !== undefined && !isContainerName(container)) throw new Error(`"${container}" is not a container name or id`);
  if (host !== null && !isSshHost(host)) throw new Error(`"${host}" is not a host ssh can reach: give user@host or a name from your ssh config`);
  const job = pid !== undefined ? { kind: "process" as const, pid: Number(pid) } : { kind: "container" as const, name: container! };
  return { session, request: { job, sshHost: host, message: positionals.join(" ") || null, resume: !values["no-resume"] } };
}

/** Plain, unlike console.error, which Bun colours red on a terminal: agents read this. */
function fail(problem: string, exitCode: number) {
  process.stderr.write(`mirador when-done: ${problem}\n`);
  process.exitCode = exitCode;
}

/** Lets the agent end its turn instead of polling: the host checks on the job, and the agent hears back when it ends. */
async function whenDone(args: string[]) {
  let parsed: ReturnType<typeof jobWaitRequest>;
  try {
    parsed = jobWaitRequest(args);
  } catch (error) {
    return fail(`${(error as Error).message}\n\n${whenDoneUsage}`, 2);
  }
  const { MIRADOR_URL: url, MIRADOR_SCRIPT_TOKEN: token } = process.env;
  const session = parsed.session ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!url || !token) return fail("MIRADOR_URL and MIRADOR_SCRIPT_TOKEN are not set; run it from an agent in Mirador, or a script it started", 2);
  if (!session) return fail("CLAUDE_CODE_SESSION_ID is not set; pass --session", 2);
  const response = await fetch(`${url}/sessions/${encodeURIComponent(session)}/job-waits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(parsed.request),
  }).catch(() => null);
  if (!response?.ok) return fail(response ? await response.text() : `could not reach Mirador at ${url}`, 1);
  const { wait } = await response.json();
  const whoHears = wait.resume ? "you get this as the user's next message" : "Mirador tells the user";
  console.log(`Mirador waits for ${describeJob(wait)}. When it ends, ${whoHears}:\n${wait.message}`);
  if (wait.resume) console.log("End your turn now rather than wait for it.");
}

const commands = new Map<string, (args: string[]) => void | Promise<void>>([
  ["sign-in", signIn],
  ["invite", invite],
  ["approve", approve],
  ["devices", listDevices],
  ["when-done", whenDone],
]);
const asksForHelp = (command: string | undefined) => command === undefined || ["help", "--help", "-h"].includes(command);

const [command] = process.argv.slice(2);
const run = command === undefined ? undefined : commands.get(command);
if (run) await run(process.argv.slice(3));
else if (asksForHelp(command)) console.log(usage);
else {
  console.error(`mirador: unknown command "${command}"\n\n${usage}`);
  process.exitCode = 2;
}
