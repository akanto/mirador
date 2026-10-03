import { useCallback, useEffect, useRef, useState } from "react";
import type { Machine, MachineStatus } from "../shared/model.ts";
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
    .map((machine) => (
      <MachineFrame key={machine.id} machine={machine} shown={machine.id === shownId} opening={opening?.machineId === machine.id ? opening : null} />
    ));
}
