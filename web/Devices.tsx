import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { connectedFrom, deviceStatus, joinedOn } from "../shared/devices.ts";
import { askToJoin, spacedNumber } from "../shared/join-requests.ts";
import { inviteLink, joinCodeIn } from "../shared/machines.ts";
import type { PublicAddress, ReachabilitySettings } from "../shared/model.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { setConnectedDevicesInSidebar, useConnectedDevicesInSidebar } from "./connected-devices.ts";
import { connection } from "./connection.ts";
import { inDesktopApp } from "./desktop-bridge.ts";
import { hints } from "./hints.ts";
import { QrCode } from "./QrCode.tsx";
import { saveSetting } from "./saved-setting.ts";
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
/** How other devices reach this host: at an address a proxy gives it, over the network itself, or nowhere. */
type ReachRoute = "address" | "network" | "none";

const routeOf = (settings: ReachabilitySettings): ReachRoute => {
  if (settings.publicAddressSetByEnvironment || settings.savedPublicAddress) return "address";
  const listening = settings.networkSetByEnvironment ? settings.network : settings.savedNetwork;
  return listening ? "network" : "none";
};

/**
 * The two settings are one choice, so they are saved together: the address first, as it is the one that can be wrong.
 * A proxy on another machine reaches the host through its network listener, so that route keeps both.
 */
async function saveRoute(route: ReachRoute, address: PublicAddress | null, proxyElsewhere = false) {
  const problem = await saveSetting((requestId) => ({ type: "settings.set-public-address", requestId, address: route === "address" ? address : null }));
  if (problem) return problem;
  return await saveSetting((requestId) => ({ type: "settings.set-network", requestId, on: route === "network" || (route === "address" && address !== null && proxyElsewhere) }));
}

/**
 * One way other devices reach this host. Only the chosen one shows its controls, so no setting looks like it applies
 * when it does not; the others keep theirs hidden, so what was typed there is still there on coming back.
 */
function RouteOption({
  title,
  description,
  hint,
  chosen,
  locked,
  onChoose,
  children,
}: {
  title: string;
  description: ReactNode;
  hint?: string;
  chosen: boolean;
  locked: boolean;
  onChoose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="route-card" data-chosen={chosen} data-hint={hint}>
      <label className="route-choice">
        <input type="radio" name="reach-route" checked={chosen} disabled={locked} onChange={onChoose} />
        {title}
      </label>
      <p className="hint">{description}</p>
      {children && (
        <div className="route-controls" hidden={!chosen}>
          {children}
        </div>
      )}
    </div>
  );
}

function AddressRoute({
  settings,
  onSave,
  onProblem,
}: {
  settings: ReachabilitySettings;
  onSave: (address: PublicAddress | null, proxyElsewhere: boolean) => void;
  onProblem: (problem: string) => void;
}) {
  const { publicAddress, savedPublicAddress, publicAddressSetByEnvironment: setByEnvironment } = settings;
  const shown = setByEnvironment ? publicAddress : savedPublicAddress;
  const savedProxyElsewhere = savedPublicAddress !== null && settings.savedNetwork;
  const [origin, setOrigin] = useState(shown?.origin ?? "");
  const [canvasOrigin, setCanvasOrigin] = useState(shown?.canvasOrigin ?? "");
  const [proxyElsewhere, setProxyElsewhere] = useState(savedProxyElsewhere);
  useEffect(() => {
    setOrigin(shown?.origin ?? "");
    setCanvasOrigin(shown?.canvasOrigin ?? "");
  }, [shown?.origin, shown?.canvasOrigin]);
  useEffect(() => setProxyElsewhere(savedProxyElsewhere), [savedProxyElsewhere]);

  const edited = origin.trim() !== (shown?.origin ?? "") || canvasOrigin.trim() !== (shown?.canvasOrigin ?? "") || proxyElsewhere !== savedProxyElsewhere;
  const save = (event: FormEvent) => {
    event.preventDefault();
    onSave(origin.trim() || canvasOrigin.trim() ? { origin, canvasOrigin } : null, proxyElsewhere);
  };
  const useFound = (address: PublicAddress) => {
    setOrigin(address.origin);
    setCanvasOrigin(address.canvasOrigin);
    onSave(address, proxyElsewhere);
  };

  return (
    <form className="public-address" aria-label="Address on your network" onSubmit={save}>
      <p className="hint">
        {setByEnvironment ? (
          <>
            The host's environment sets its address (<code>MIRADOR_PUBLIC_ORIGIN</code> and <code>MIRADOR_PUBLIC_CANVAS_ORIGIN</code>), so it can't be changed
            here.
          </>
        ) : proxyElsewhere ? (
          <>
            Where other devices open Mirador, and where its canvas pages load the libraries they draw with. A proxy on another machine can't reach this
            machine's own ports, so Mirador also serves HTTPS on the network, and the proxy forwards to port <code>{settings.networkPort}</code> for Mirador
            and <code>{settings.networkCanvasPort}</code> for the canvas.
          </>
        ) : (
          <>
            Where other devices open Mirador — its own port, <code>{settings.port}</code> — and where its canvas pages load the libraries they draw with, a port
            of their own, <code>{settings.canvasAssetsPort}</code>: a separate origin, so a page an agent wrote cannot reach Mirador's own storage.
          </>
        )}
      </p>
      {!setByEnvironment && (
        <label className="proxy-elsewhere" data-hint={hints.proxyElsewhere}>
          <input type="checkbox" checked={proxyElsewhere} onChange={(event) => setProxyElsewhere(event.target.checked)} />
          The proxy runs on another machine
        </label>
      )}
      {!setByEnvironment && <AddressFinder onUse={useFound} onProblem={onProblem} />}
      <div className="address-fields">
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
      </div>
    </form>
  );
}

type AddressSearch = Extract<ServerMessage, { type: "address.found" }>;

/** Finds the address other devices reach this host at, so the two fields need no proxy knowledge typed by hand. */
function AddressFinder({ onUse, onProblem }: { onUse: (address: PublicAddress) => void; onProblem: (problem: string) => void }) {
  const [looking, setLooking] = useState<"find" | "serve" | null>(null);
  const [search, setSearch] = useState<AddressSearch | null>(null);

  const look = async (serving: boolean) => {
    setLooking(serving ? "serve" : "find");
    try {
      const found = await connection.sendAndAwait(
        (requestId) => ({ type: serving ? "address.serve" : "address.find", requestId }),
        (message, requestId) => (message.type === "address.found" && message.requestId === requestId ? message : undefined),
      );
      setSearch(found);
      if (found.problem) onProblem(found.problem);
    } catch (error) {
      onProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setLooking(null);
    }
  };

  return (
    <div className="address-finder">
      <button type="button" data-hint={hints.findAddress} disabled={looking !== null} onClick={() => void look(false)}>
        {looking === "find" ? "Looking…" : "Find the address"}
      </button>
      {search && <AddressOutcome search={search} looking={looking} onServe={() => void look(true)} onUse={onUse} />}
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
      Nothing answered: no address of this machine's reaches Mirador yet, and it has no Tailscale. The choice below spells out what else there is.
    </p>
  );
}

function ReachabilitySettingsSection({ settings }: { settings: ReachabilitySettings }) {
  const savedChoice = routeOf(settings);
  const locked = settings.publicAddressSetByEnvironment || settings.networkSetByEnvironment;
  const [route, setRoute] = useState(savedChoice);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setRoute(savedChoice), [savedChoice]);

  /** Picking a way only brings out what it needs, so looking at one loses nothing; its button applies it. */
  const reveal = (wanted: ReachRoute) => {
    setRoute(wanted);
    setProblem(null);
  };

  const apply = (wanted: ReachRoute, address: PublicAddress | null = null, proxyElsewhere = false) => {
    setRoute(wanted);
    setProblem(null);
    void saveRoute(wanted, address, proxyElsewhere).then(setProblem);
  };

  const proxyGivesTheAddress = settings.savedPublicAddress !== null || settings.publicAddressSetByEnvironment;

  const useThis = (wanted: ReachRoute) =>
    savedChoice !== wanted && (
      <button type="button" onClick={() => apply(wanted)}>
        Use this
      </button>
    );

  return (
    <section className="reachability" aria-label="How other devices reach this Mirador">
      <h3>How other devices reach it</h3>
      <p className="hint" data-hint={hints.reachRoute}>
        One at a time. The host uses the chosen one from its next start, for invite links and for the devices that already joined.
      </p>
      <div className="routes" role="radiogroup" aria-label="How other devices reach this Mirador">
        <RouteOption
          title="At an address a proxy gives it"
          chosen={route === "address"}
          locked={locked}
          onChoose={() => reveal("address")}
          description="A proxy in front of Mirador gives it an address other devices reach it at — tailscale serve does this in one command."
        >
          <AddressRoute settings={settings} onSave={(address, proxyElsewhere) => apply("address", address, proxyElsewhere)} onProblem={setProblem} />
        </RouteOption>
        <RouteOption
          title="Over the network, with no address"
          hint={hints.networkReachability}
          chosen={route === "network"}
          locked={locked}
          onChoose={() => reveal("network")}
          description={
            <>
              Mirador serves HTTPS itself on port <code>{settings.networkPort}</code>, with a certificate it makes. Devices on the same network reach it
              directly{settings.network && settings.publicAddress && !proxyGivesTheAddress ? ` at ${settings.publicAddress.origin}` : ""}, with no proxy and no VPN; browsers warn once about
              the certificate
              {settings.network && settings.authorityFingerprint ? (
                <>
                  , or trust it for good once they install Mirador's <a href="/mirador-ca.pem">certificate authority</a>
                </>
              ) : null}
              .
            </>
          }
        >
          {useThis("network")}
        </RouteOption>
        <RouteOption
          title="Only on this machine"
          chosen={route === "none"}
          locked={locked}
          onChoose={() => reveal("none")}
          description="No other device reaches it, and the host serves nothing on the network."
        >
          {useThis("none")}
        </RouteOption>
      </div>
      {locked && (
        <p className="hint">
          The host's environment sets how other devices reach it (<code>MIRADOR_PUBLIC_ORIGIN</code>, <code>MIRADOR_PUBLIC_CANVAS_ORIGIN</code> or{" "}
          <code>MIRADOR_NETWORK</code>), so this can't be changed here.
        </p>
      )}
      {problem && <p className="setting-problem">{problem}</p>}
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
      No link and no QR code: nothing has told Mirador how other devices reach it. One of the choices below gives it an address — the host uses it from its next
      start.
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
