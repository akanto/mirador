import { useEffect, useState, type FormEvent } from "react";
import { askToJoin, spacedNumber } from "../shared/join-requests.ts";
import { inviteLink, joinCodeIn } from "../shared/machines.ts";
import type { ReachabilitySettings } from "../shared/model.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection } from "./connection.ts";
import { inDesktopApp } from "./desktop-bridge.ts";
import { hints } from "./hints.ts";
import { relativeTimeOf } from "./relative-time.ts";

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
          On this machine itself, you can instead open the link the host printed in your terminal (it ends with <code>/auth?token=…</code>).
        </p>
      )}
    </div>
  );
}

type DevicesListed = Extract<ServerMessage, { type: "devices.listed" }>;
type Invite = Extract<ServerMessage, { type: "devices.invited" }>;

const joinedOn = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const timeOf = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** Sends a setting to the host, which saves it for its next start; null once saved, else what is wrong with it. */
function saveSetting(send: (requestId: string) => ClientMessage, answered: (problem: string | null) => void) {
  const requestId = crypto.randomUUID();
  const unsubscribe = connection.onMessage((message) => {
    if (message.type !== "settings.saved" || message.requestId !== requestId) return;
    unsubscribe();
    answered(message.problem);
  });
  if (!connection.send(send(requestId))) unsubscribe();
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
      <label>
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
            The address other devices reach this Mirador at, and a second one its canvas pages load their libraries from. Set them when a proxy, such as{" "}
            <code>tailscale serve</code>, gives it its addresses.
            {usesNetworkAddress && (
              <>
                {" "}
                On the network it now uses <code>{usesNetworkAddress.origin}</code>.
              </>
            )}
          </>
        )}
      </p>
      <label>
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
      <label>
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
        Save
      </button>
      {problem && <p className="setting-problem">{problem}</p>}
    </form>
  );
}

function ReachabilitySettingsSection({ settings }: { settings: ReachabilitySettings }) {
  return (
    <section className="reachability" aria-label="How other devices reach this Mirador">
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

export function DeviceSettings() {
  const [listed, setListed] = useState<DevicesListed | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);

  useEffect(() => {
    const unsubscribe = connection.onMessage((message) => {
      if (message.type === "devices.listed") setListed(message);
    });
    connection.send({ type: "devices.list" });
    return unsubscribe;
  }, []);

  const createInvite = () => {
    const requestId = crypto.randomUUID();
    const unsubscribe = connection.onMessage((message) => {
      if (message.type !== "devices.invited" || message.requestId !== requestId) return;
      unsubscribe();
      setInvite(message);
    });
    connection.send({ type: "devices.invite", requestId });
  };

  const publicOrigin = listed?.reachability.publicAddress?.origin ?? null;
  return (
    <>
      <h3>Devices</h3>
      <p className="hint">
        Other browsers and apps that joined this Mirador with an invite code. Each signs in with a key of its own; revoking one signs it out at once.
      </p>
      {listed && <ReachabilitySettingsSection settings={listed.reachability} />}
      <ul className="device-list" aria-label="Devices">
        {listed?.devices.map((device) => (
          <li key={device.id}>
            <span className="device-name">{device.name}</span>
            {device.id === listed.thisDeviceId && <span className="device-this">this device</span>}
            <span className="device-seen">
              joined {joinedOn(device.joinedAt)} · last seen {relativeTimeOf(device.lastSeenAt)}
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
            {publicOrigin && (
              <span>
                Or open <code className="invite-link">{inviteLink(publicOrigin, invite.code, listed?.reachability.authorityFingerprint)}</code> on the device.
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
