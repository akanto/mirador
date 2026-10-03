import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { spacedNumber } from "../shared/join-requests.ts";
import { inviteIn } from "../shared/machines.ts";
import type { Machine, MachineStatus } from "../shared/model.ts";
import type { ClientMessage } from "../shared/protocol.ts";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { mostUrgentTone } from "./waiting.ts";

const machineFromHash = () => location.hash.match(/^#\/m\/([\w-]+)$/)?.[1] ?? null;

/** This host shows other machines at ports of this computer, which a page opened from elsewhere cannot reach. */
export const showsMachinesHere = () => ["127.0.0.1", "localhost"].includes(location.hostname);

const relayAddress = (machine: Machine) => `${location.protocol}//${location.hostname}:${machine.relayPort}/`;

const initials = (name: string) =>
  name
    .split(/[\s.\-_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

/** A conversation to open in a machine's frame, e.g. from that machine's notification; each request is a new object. */
export interface ConversationToOpen {
  machineId: string;
  conversationId: string;
}

/** Which machine the window shows (null for this computer), and every machine it has shown, which stay loaded. */
export function useShownMachine(machines: Machine[], machinesLoaded: boolean) {
  const [shownId, setShownId] = useState(machineFromHash);
  const [visited, setVisited] = useState(() => new Set(shownId ? [shownId] : []));
  const [opening, setOpening] = useState<ConversationToOpen | null>(null);
  const shown = machines.find(({ id }) => id === shownId) ?? null;
  useEffect(() => {
    if (machinesLoaded && shownId && !shown) setShownId(null);
  }, [machinesLoaded, shownId, shown]);
  const show = useCallback((machineId: string | null) => {
    setShownId(machineId);
    if (machineId) setVisited((before) => new Set(before).add(machineId));
  }, []);
  const openIn = useCallback((machineId: string, conversationId: string) => {
    setOpening({ machineId, conversationId });
    show(machineId);
  }, []);
  return { shownId, shown, visited, opening, show, openIn };
}

function WaitingBadge({ status }: { status: MachineStatus | undefined }) {
  const waiting = status?.waiting ?? [];
  if (waiting.length === 0) return null;
  return <span className={`rail-waiting tone-${mostUrgentTone(waiting)}`}>{waiting.length}</span>;
}

const machineHint = (machine: Machine, status: MachineStatus | undefined) =>
  [
    machine.name,
    machine.origin,
    !machine.joined && "not joined yet",
    status?.reachable === false && "not answering",
    status?.waiting.length && `${status.waiting.length} waiting for you`,
  ]
    .filter(Boolean)
    .join(" · ");

export function MachineRail({
  machines,
  statuses,
  shownId,
  onShow,
  onManage,
}: {
  machines: Machine[];
  statuses: MachineStatus[];
  shownId: string | null;
  onShow: (machineId: string | null) => void;
  onManage: () => void;
}) {
  return (
    <nav className="machine-rail" aria-label="Machines">
      <button
        type="button"
        className={`rail-machine this-computer ${shownId === null ? "shown" : ""}`}
        aria-label="This computer"
        aria-current={shownId === null}
        data-hint={hints.thisComputer}
        onClick={() => onShow(null)}
      >
        ⌂
      </button>
      {machines.map((machine) => {
        const status = statuses.find(({ machineId }) => machineId === machine.id);
        const away = !machine.joined || status?.reachable === false;
        return (
          <button
            key={machine.id}
            type="button"
            className={`rail-machine ${machine.id === shownId ? "shown" : ""} ${away ? "away" : ""}`}
            aria-label={machine.name}
            aria-current={machine.id === shownId}
            data-hint={machineHint(machine, status)}
            onClick={() => onShow(machine.id)}
          >
            {initials(machine.name)}
            <WaitingBadge status={status} />
          </button>
        );
      })}
      <button type="button" className="rail-manage" aria-label="Machines…" data-hint={hints.manageMachines} onClick={onManage}>
        +
      </button>
    </nav>
  );
}

const conversationAddress = (machine: Machine, conversationId: string) => `${relayAddress(machine)}#/c/${conversationId}`;

function MachineFrame({ machine, shown, opening }: { machine: Machine; shown: boolean; opening: ConversationToOpen | null }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const openedWith = useRef(opening);
  const [address] = useState(() => (opening ? conversationAddress(machine, opening.conversationId) : relayAddress(machine)));
  useEffect(() => {
    if (opening && opening !== openedWith.current) frame.current!.contentWindow!.location.href = conversationAddress(machine, opening.conversationId);
  }, [opening]);
  return <iframe ref={frame} className={`machine-frame ${shown ? "shown" : ""}`} title={machine.name} src={address} allow="clipboard-read; clipboard-write" />;
}

/** In a machine's place until this computer has joined it, as the machine shows nothing to a computer without an invite. */
function JoinMachinePanel({ machine }: { machine: Machine }) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [askedNumber, setAskedNumber] = useState<string | null>(null);

  /** Follows the host's answers until the last, as asking to join waits there until someone approves it. */
  const tryToJoin = (send: (requestId: string) => ClientMessage) => {
    const requestId = crypto.randomUUID();
    const stopListening = connection.onMessage((message) => {
      if (message.type === "machine.join-asked" && message.requestId === requestId) return setAskedNumber(message.number);
      if (message.type !== "machine.join-answered" || message.requestId !== requestId) return;
      stopListening();
      setProblem(message.problem);
      setJoining(false);
      setAskedNumber(null);
    });
    if (!connection.send(send(requestId))) return stopListening();
    setProblem(null);
    setJoining(true);
  };
  const join = (event: FormEvent) => {
    event.preventDefault();
    tryToJoin((requestId) => ({ type: "machine.join", requestId, machineId: machine.id, ...inviteIn(text) }));
  };
  const askToJoin = () => tryToJoin((requestId) => ({ type: "machine.ask-to-join", requestId, machineId: machine.id }));

  return (
    <section className="machine-join gate join-machine" aria-label={`Join ${machine.name}`}>
      <h1>Join {machine.name}</h1>
      {askedNumber ? (
        <div className="join-asked" role="status" aria-label="Waiting for approval">
          <p>
            Waiting for approval on <strong>{machine.name}</strong>. Type this number there:
          </p>
          <p className="join-number">{spacedNumber(askedNumber)}</p>
          <p className="hint">
            Its Mirador shows the request on its own screen, and on the devices that have joined it; or run <code>mirador approve</code> there.
          </p>
        </div>
      ) : (
        <>
          <p>
            This computer has not joined <strong>{machine.name}</strong> at {new URL(machine.origin).host} yet. Ask to join, and approve it there by typing
            the number this computer then shows.
          </p>
          <button type="button" className="primary" disabled={joining} onClick={askToJoin}>
            Ask to join
          </button>
          <p>
            Or join with an invite code. Get one in its Settings → Devices, from a device that has joined it, or run <code>mirador invite</code> on it.
          </p>
          <form onSubmit={join}>
            <label>
              Invite code or link
              <input value={text} onChange={(event) => setText(event.target.value)} placeholder="ABCD-EFGH-JKLM" autoFocus autoComplete="off" spellCheck={false} />
            </label>
            <button type="submit" className="primary" disabled={joining || !text.trim()}>
              {joining ? "Joining…" : "Join"}
            </button>
          </form>
        </>
      )}
      {problem && <p className="join-problem">{problem}</p>}
    </section>
  );
}

/** Each machine's own Mirador, as its host serves it; once shown it stays loaded so going back to it is instant. */
export function MachineFrames({
  machines,
  shownId,
  visited,
  opening,
}: {
  machines: Machine[];
  shownId: string | null;
  visited: Set<string>;
  opening: ConversationToOpen | null;
}) {
  return machines
    .filter((machine) => visited.has(machine.id) && machine.relayPort !== null)
    .map((machine) =>
      machine.joined ? (
        <MachineFrame key={machine.id} machine={machine} shown={machine.id === shownId} opening={opening?.machineId === machine.id ? opening : null} />
      ) : (
        machine.id === shownId && <JoinMachinePanel key={machine.id} machine={machine} />
      ),
    );
}
