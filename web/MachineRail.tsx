import { useCallback, useEffect, useState } from "react";
import type { Machine } from "../shared/model.ts";
import { hints } from "./hints.ts";

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

/** Which machine the window shows (null for this computer), and every machine it has shown, which stay loaded. */
export function useShownMachine(machines: Machine[], machinesLoaded: boolean) {
  const [shownId, setShownId] = useState(machineFromHash);
  const [visited, setVisited] = useState(() => new Set(shownId ? [shownId] : []));
  const shown = machines.find(({ id }) => id === shownId) ?? null;
  useEffect(() => {
    if (machinesLoaded && shownId && !shown) setShownId(null);
  }, [machinesLoaded, shownId, shown]);
  const show = useCallback((machineId: string | null) => {
    setShownId(machineId);
    if (machineId) setVisited((before) => new Set(before).add(machineId));
  }, []);
  return { shownId, shown, visited, show };
}

export function MachineRail({
  machines,
  shownId,
  onShow,
  onManage,
}: {
  machines: Machine[];
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
      {machines.map((machine) => (
        <button
          key={machine.id}
          type="button"
          className={`rail-machine ${machine.id === shownId ? "shown" : ""}`}
          aria-label={machine.name}
          aria-current={machine.id === shownId}
          data-hint={`${machine.name} · ${machine.origin}`}
          onClick={() => onShow(machine.id)}
        >
          {initials(machine.name)}
        </button>
      ))}
      <button type="button" className="rail-manage" aria-label="Machines…" data-hint={hints.manageMachines} onClick={onManage}>
        +
      </button>
    </nav>
  );
}

/** Each machine's own Mirador, as its host serves it; once shown it stays loaded so going back to it is instant. */
export function MachineFrames({ machines, shownId, visited }: { machines: Machine[]; shownId: string | null; visited: Set<string> }) {
  return machines
    .filter((machine) => visited.has(machine.id) && machine.relayPort !== null)
    .map((machine) => (
      <iframe
        key={machine.id}
        className={`machine-frame ${machine.id === shownId ? "shown" : ""}`}
        title={machine.name}
        src={relayAddress(machine)}
        allow="clipboard-read; clipboard-write"
      />
    ));
}
