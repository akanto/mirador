import { useEffect, useState, type FormEvent } from "react";
import { connectedFrom, deviceStatus, joinedOn } from "../shared/devices.ts";
import { askToJoin, spacedNumber } from "../shared/join-requests.ts";
import { inviteLink, joinCodeIn } from "../shared/machines.ts";
import type { PublicAddress, ReachabilitySettings } from "../shared/model.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { setConnectedDevicesInSidebar, useConnectedDevicesInSidebar } from "./connected-devices.ts";
import { connection } from "./connection.ts";
import { inDesktopApp } from "./desktop-bridge.ts";
import { hints } from "./hints.ts";
import { QrCode } from "./QrCode.tsx";
import type { DevicesListed } from "./state.ts";

/** Read before the app first draws: it then replaces the address's #part with the open conversation's. */
const joinCodeInLink = joinCodeIn(location.hash);

function browserName(userAgent: string) {
  if (inDesktopApp()) return "Mirador app";
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/Firefox\/|FxiOS/.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS/.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Browser";
}

function systemName(userAgent: string) {
  if (/iPhone|iPad/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/Mac OS X/.test(userAgent)) return "macOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

function guessedDeviceName() {
  const system = systemName(navigator.userAgent);
  return system ? `${browserName(navigator.userAgent)} on ${system}` : browserName(navigator.userAgent);
}

const isThisMachine = () => ["127.0.0.1", "localhost"].includes(location.hostname);
/** In the rail of another computer's Mirador, which joins its machines itself. */
const shownInAnotherMirador = () => window.self !== window.top;

const postToThisMachine = (path: string, body: object) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);

/** Shown instead of the app until this browser has signed in, with the host's own link or by joining with an invite code. */
export function JoinMachine() {
  const [code, setCode] = useState(joinCodeInLink ?? "");
  const [name, setName] = useState(guessedDeviceName);
  const [problem, setProblem] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [askedNumber, setAskedNumber] = useState<string | null>(null);

  const ask = async () => {
    setJoining(true);
    setProblem(null);
    try {
      await askToJoin(postToThisMachine, { name, authorityFingerprint: null, machineName: location.hostname }, setAskedNumber);
      location.replace("/");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setAskedNumber(null);
      setJoining(false);
    }
  };

  const join = async (codeToUse: string) => {
    setJoining(true);
    const response = await fetch("/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: codeToUse, name }),
    }).catch(() => null);
    if (response?.ok) return location.replace("/");
    setProblem(response ? await response.text() : "The machine did not answer. Is its Mirador running?");
    setJoining(false);
  };

  const joinWithLink = (linkCode: string | null) => {
    if (!linkCode) return;
    setCode(linkCode);
    void join(linkCode);
  };
  useEffect(() => {
    joinWithLink(joinCodeInLink);
  }, []);
  useEffect(() => {
    const joinWithPastedLink = () => joinWithLink(joinCodeIn(location.hash));
    window.addEventListener("hashchange", joinWithPastedLink);
    return () => window.removeEventListener("hashchange", joinWithPastedLink);
  });

  return (
    <div className="gate join-machine">
      <h1>Join this machine</h1>
      {askedNumber ? (
        <div className="join-asked" role="status" aria-label="Waiting for approval">
          <p>
            Waiting for approval on <strong>{location.hostname}</strong>. Type this number there:
          </p>
          <p className="join-number">{spacedNumber(askedNumber)}</p>
          <p className="hint">
            Its Mirador shows the request on its own screen, and on the devices that have joined it; or run <code>mirador approve</code> there.
          </p>
        </div>
      ) : (
        <>
          <p>
            Mirador on <strong>{location.host}</strong> lets in devices that someone there approves, or that have an invite code. Get one in Settings →
            Devices on a device that has joined, or run <code>mirador invite</code> on the machine.
          </p>
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void join(code);
            }}
          >
            <label>
              Name this device
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            {!shownInAnotherMirador() && (
              <button type="button" className="primary" disabled={joining || !name.trim()} onClick={() => void ask()}>
                Ask to join
              </button>
            )}
            <label>
              Invite code
              <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCD-EFGH-JKLM" autoFocus autoComplete="off" spellCheck={false} />
            </label>
            <button type="submit" className="primary" disabled={joining || !code.trim()}>
              {joining ? "Joining…" : "Join"}
            </button>
          </form>
        </>
      )}
      {problem && <p className="join-problem">{problem}</p>}
      {isThisMachine() && (
        <p className="hint">
          On this machine itself, you can instead sign in with a one-time link: the host prints one in the terminal that started it, and <code>mirador sign-in</code> makes a new one.
        </p>
      )}
    </div>
  );
}

type Invite = Extract<ServerMessage, { type: "devices.invited" }>;

const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** Sends a setting to the host, which saves it for its next start; null once saved, else what is wrong with it. */
async function saveSetting(send: (requestId: string) => ClientMessage, answered: (problem: string | null) => void) {
  try {
    const problem = await connection.sendAndAwait(
      send,
      (message, requestId) => (message.type === "settings.saved" && message.requestId === requestId ? message.problem : undefined),
    );
    answered(problem);
  } catch (error) {
    answered(error instanceof Error ? error.message : String(error));
  }
}

function NetworkSwitch({ settings }: { settings: ReachabilitySettings }) {
  const [problem, setProblem] = useState<string | null>(null);
  const saved = settings.networkSetByEnvironment ? settings.network : settings.savedNetwork;
  const [on, setOn] = useState(saved);
  useEffect(() => setOn(saved), [saved]);

  const switchTo = (wanted: boolean) => {
    setOn(wanted);
    saveSetting(
      (requestId) => ({ type: "settings.set-network", requestId, on: wanted }),
      (problemSaving) => {
        setProblem(problemSaving);
        if (problemSaving) setOn(saved);
      },
    );
  };

  return (
    <div className="network-switch">
      <label data-hint={hints.networkReachability}>
        <input type="checkbox" checked={on} disabled={settings.networkSetByEnvironment} onChange={(event) => switchTo(event.target.checked)} />
        Reachable on the network, over HTTPS at port {settings.networkPort}
      </label>
      <p className="hint">
        {settings.networkSetByEnvironment ? (
          <>
            The host's environment sets this (<code>MIRADOR_NETWORK</code>), so it can't be changed here.{" "}
          </>
        ) : null}
        Other devices on the same network, at home or at work, reach this Mirador directly, with no proxy or VPN. It makes its own certificate, which
        browsers warn about once
        {settings.network && settings.authorityFingerprint ? (
          <>
            , or trust for good once they install its <a href="/mirador-ca.pem">certificate authority</a>
          </>
        ) : null}
        .
      </p>
      {problem && <p className="setting-problem">{problem}</p>}
    </div>
  );
}

function PublicAddressSettings({ settings }: { settings: ReachabilitySettings }) {
  const { publicAddress, savedPublicAddress, publicAddressSetByEnvironment: setByEnvironment } = settings;
  const shown = setByEnvironment ? publicAddress : savedPublicAddress;
  const [origin, setOrigin] = useState(shown?.origin ?? "");
  const [canvasOrigin, setCanvasOrigin] = useState(shown?.canvasOrigin ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setOrigin(shown?.origin ?? "");
    setCanvasOrigin(shown?.canvasOrigin ?? "");
  }, [shown?.origin, shown?.canvasOrigin]);

  const edited = origin.trim() !== (shown?.origin ?? "") || canvasOrigin.trim() !== (shown?.canvasOrigin ?? "");
  const usesNetworkAddress = settings.network && !shown && publicAddress;

  const save = (event: FormEvent) => {
    event.preventDefault();
    const address = origin.trim() || canvasOrigin.trim() ? { origin, canvasOrigin } : null;
    saveSetting((requestId) => ({ type: "settings.set-public-address", requestId, address }), setProblem);
  };

  return (
    <form className="public-address" aria-label="Address on your network" onSubmit={save}>
      <p className="hint">
        {setByEnvironment ? (
          <>
            The host's environment sets its address on your network (<code>MIRADOR_PUBLIC_ORIGIN</code> and <code>MIRADOR_PUBLIC_CANVAS_ORIGIN</code>), so it
            can't be changed here.
          </>
        ) : (
          <>
            The address other devices reach this Mirador at — its own port, <code>{settings.port}</code> — and a second one where its canvas pages load the libraries
            they draw with, which Mirador serves on a port of their own, <code>{settings.canvasAssetsPort}</code>. A proxy in front of both, such as{" "}
            <code>tailscale serve</code>, gives each one an address.
            {usesNetworkAddress && (
              <>
                {" "}
                On the network it now uses <code>{usesNetworkAddress.origin}</code>.
              </>
            )}
          </>
        )}
      </p>
      <label data-hint={hints.address}>
        Address
        <input
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://box.example.ts.net"
          disabled={setByEnvironment}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label data-hint={hints.canvasAddress}>
        Canvas address
        <input
          value={canvasOrigin}
          onChange={(event) => setCanvasOrigin(event.target.value)}
          placeholder="https://box.example.ts.net:8443"
          disabled={setByEnvironment}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button type="submit" disabled={setByEnvironment || !edited}>
        Save address
      </button>
      {problem && <p className="setting-problem">{problem}</p>}
    </form>
  );
}

type AddressSearch = Extract<ServerMessage, { type: "address.found" }>;

/** Finds the address other devices reach this host at, so the two fields need no proxy knowledge typed by hand. */
function AddressFinder() {
  const [looking, setLooking] = useState<"find" | "serve" | null>(null);
  const [search, setSearch] = useState<AddressSearch | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const look = async (serving: boolean) => {
    setLooking(serving ? "serve" : "find");
    setProblem(null);
    try {
      setSearch(
        await connection.sendAndAwait(
          (requestId) => ({ type: serving ? "address.serve" : "address.find", requestId }),
          (message, requestId) => (message.type === "address.found" && message.requestId === requestId ? message : undefined),
        ),
      );
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setLooking(null);
    }
  };

  return (
    <div className="address-finder">
      <button type="button" data-hint={hints.findAddress} disabled={looking !== null} onClick={() => void look(false)}>
        {looking === "find" ? "Looking…" : "Find the address"}
      </button>
      {search && (
        <AddressOutcome
          search={search}
          looking={looking}
          onServe={() => void look(true)}
          onUse={(address) => void saveSetting((requestId) => ({ type: "settings.set-public-address", requestId, address }), setProblem)}
        />
      )}
      {search?.problem && <p className="setting-problem">{search.problem}</p>}
      {problem && <p className="setting-problem">{problem}</p>}
    </div>
  );
}

function AddressOutcome({
  search,
  looking,
  onServe,
  onUse,
}: {
  search: AddressSearch;
  looking: "find" | "serve" | null;
  onServe: () => void;
  onUse: (address: PublicAddress) => void;
}) {
  if (search.addresses.length > 0) {
    return (
      <ul className="addresses-found" aria-label="Addresses found">
        {search.addresses.map((address) => (
          <li key={address.origin}>
            <span>
              <code>{address.origin}</code> and <code>{address.canvasOrigin}</code>{" "}
              <span className="address-how">{address.how === "tailnet" ? "this machine's name on the tailnet" : "an address a device already used"}</span>
            </span>
            <button type="button" onClick={() => onUse(address)}>
              Use these
            </button>
          </li>
        ))}
      </ul>
    );
  }
  if (search.tailscale === "present") {
    return (
      <p className="hint">
        Nothing answered yet. This machine has Tailscale, which can put Mirador on the tailnet itself.
        <button type="button" data-hint={hints.exposeOnTailscale} disabled={looking !== null} onClick={onServe}>
          {looking === "serve" ? "Exposing…" : "Expose Mirador on Tailscale"}
        </button>
      </p>
    );
  }
  return (
    <p className="hint">
      Nothing answered: no address of this machine's reaches Mirador yet, and it has no Tailscale. Devices on the same network reach it directly — turn on{" "}
      <em>Reachable on the network</em> below, which needs no address and no proxy.
    </p>
  );
}

function ReachabilitySettingsSection({ settings }: { settings: ReachabilitySettings }) {
  return (
    <section className="reachability" aria-label="How other devices reach this Mirador">
      {!settings.publicAddressSetByEnvironment && <AddressFinder />}
      <NetworkSwitch settings={settings} />
      <PublicAddressSettings settings={settings} />
      {settings.restartNeeded && (
        <p className="restart-needed">
          Saved. The host uses it from its next start.
          <button type="button" data-hint={hints.restartHost} onClick={() => connection.send({ type: "host.restart" })}>
            Restart host
          </button>
        </p>
      )}
    </section>
  );
}

function InviteLink({ link }: { link: string }) {
  return (
    <>
      <QrCode text={link} label="Link as a QR code" />
      <span>
        Or scan this with the Mirador app on a phone, or open <code className="invite-link">{link}</code> on the device.
      </span>
    </>
  );
}

function InviteWithoutLink() {
  return (
    <span className="hint invite-without-link">
      No link and no QR code: no address is set that other devices reach this Mirador at. Set the address below, or turn on Reachable on the network — the host
      uses either from its next start.
    </span>
  );
}

export function DeviceSettings({ listed }: { listed: DevicesListed | null }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const shownInSidebar = useConnectedDevicesInSidebar();

  const createInvite = async () => {
    try {
      const invited = await connection.sendAndAwait(
        (requestId) => ({ type: "devices.invite", requestId }),
        (message, requestId) => (message.type === "devices.invited" && message.requestId === requestId ? message : undefined),
      );
      setInvite(invited);
    } catch {
      // Disconnected or failed; nothing to set
    }
  };

  const publicOrigin = listed?.reachability.publicAddress?.origin ?? null;
  return (
    <>
      <h3>Devices</h3>
      <p className="hint">
        Other browsers and apps that joined this Mirador with an invite code. Each signs in with a key of its own; revoking one signs it out at once.
      </p>
      <label className="connected-devices-switch" data-hint={hints.connectedDevicesInSidebar}>
        <input type="checkbox" checked={shownInSidebar} onChange={(event) => setConnectedDevicesInSidebar(event.target.checked)} />
        Show the connected devices in the sidebar
      </label>
      <ul className="device-list" aria-label="Devices">
        {listed?.devices.map((device) => (
          <li key={device.id} className={device.connection ? "connected" : undefined}>
            <span className="device-dot" aria-hidden="true" />
            <span className="device-name">{device.name}</span>
            {device.id === listed.thisDeviceId && <span className="device-this">this device</span>}
            <span className="device-seen">
              {deviceStatus(device)}
              {device.connection && ` · ${connectedFrom(device.connection)}`} · joined {joinedOn(device.joinedAt)}
            </span>
            <ConfirmButton
              className="danger"
              label={`Revoke ${device.name}`}
              armedText="Revoke?"
              armedHint={hints.revokeDeviceArmed}
              onConfirm={() => connection.send({ type: "device.revoke", deviceId: device.id })}
            >
              Revoke
            </ConfirmButton>
          </li>
        ))}
        {listed?.devices.length === 0 && <li className="device-none">No device has joined yet.</li>}
      </ul>
      <div className="device-invite">
        <button type="button" onClick={createInvite} data-hint={hints.inviteDevice}>
          Invite a device
        </button>
        {invite && (
          <div className="invite" aria-label="Invite">
            <span>
              Code <code className="invite-code">{invite.code}</code>, works once until {timeOf(invite.expiresAt)}.
            </span>
            {publicOrigin ? (
              <InviteLink link={inviteLink(publicOrigin, invite.code, listed?.reachability.authorityFingerprint)} />
            ) : (
              <InviteWithoutLink />
            )}
          </div>
        )}
      </div>
      {listed && <ReachabilitySettingsSection settings={listed.reachability} />}
    </>
  );
}
