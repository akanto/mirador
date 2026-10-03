import { useEffect, useState, type FormEvent } from "react";
import { inviteLink, joinCodeIn } from "../shared/machines.ts";
import type { PublicAddress } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
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

/** Shown instead of the app until this browser has signed in, with the host's own link or by joining with an invite code. */
export function JoinMachine() {
  const [code, setCode] = useState(joinCodeInLink ?? "");
  const [name, setName] = useState(guessedDeviceName);
  const [problem, setProblem] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

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
      <p>
        Mirador on <strong>{location.host}</strong> lets in devices with an invite code. Get one in Settings → Devices on a device that has joined, or
        run <code>mirador invite</code> on the machine.
      </p>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void join(code);
        }}
      >
        <label>
          Invite code
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCD-EFGH-JKLM" autoFocus autoComplete="off" spellCheck={false} />
        </label>
        <label>
          Name this device
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" className="primary" disabled={joining || !code.trim()}>
          {joining ? "Joining…" : "Join"}
        </button>
      </form>
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
const sameAddress = (one: PublicAddress | null, other: PublicAddress | null) => one?.origin === other?.origin && one?.canvasOrigin === other?.canvasOrigin;

function PublicAddressSettings({ listed }: { listed: DevicesListed }) {
  const { publicAddress, savedPublicAddress, publicAddressSetByEnvironment: setByEnvironment } = listed;
  const shown = setByEnvironment ? publicAddress : savedPublicAddress;
  const [origin, setOrigin] = useState(shown?.origin ?? "");
  const [canvasOrigin, setCanvasOrigin] = useState(shown?.canvasOrigin ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setOrigin(shown?.origin ?? "");
    setCanvasOrigin(shown?.canvasOrigin ?? "");
  }, [shown?.origin, shown?.canvasOrigin]);

  const edited = origin.trim() !== (shown?.origin ?? "") || canvasOrigin.trim() !== (shown?.canvasOrigin ?? "");
  const waitsForRestart = !setByEnvironment && !sameAddress(savedPublicAddress, publicAddress);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const requestId = crypto.randomUUID();
    const unsubscribe = connection.onMessage((message) => {
      if (message.type !== "settings.public-address-saved" || message.requestId !== requestId) return;
      unsubscribe();
      setProblem(message.problem);
    });
    const address = origin.trim() || canvasOrigin.trim() ? { origin, canvasOrigin } : null;
    connection.send({ type: "settings.set-public-address", requestId, address });
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
            Other devices reach this Mirador at its address on your network, and its canvas pages load their libraries from a second one, for example the two
            that <code>tailscale serve</code> or a reverse proxy gives it. Leave both empty to keep it to this computer.
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
      {problem && <p className="public-address-problem">{problem}</p>}
      {waitsForRestart && (
        <p className="public-address-restart">
          Saved. The host uses it from its next start.
          <button type="button" data-hint={hints.restartHost} onClick={() => connection.send({ type: "host.restart" })}>
            Restart host
          </button>
        </p>
      )}
    </form>
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

  const publicOrigin = listed?.publicAddress?.origin ?? null;
  return (
    <>
      <h3>Devices</h3>
      <p className="hint">
        Other browsers and apps that joined this Mirador with an invite code. Each signs in with a key of its own; revoking one signs it out at once.
      </p>
      {listed && <PublicAddressSettings listed={listed} />}
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
                Or open <code className="invite-link">{inviteLink(publicOrigin, invite.code)}</code> on the device.
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
