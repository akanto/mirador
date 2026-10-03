import { useEffect, useState, type FormEvent } from "react";
import { inviteLink, machineAddress } from "../shared/machines.ts";
import type { Machine } from "../shared/model.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";

/** A tab (or the desktop app's browser) of its own per machine, used again when the machine is opened again. */
export function openMachine(origin: string, joinCode: string | null = null) {
  window.open(joinCode ? inviteLink(origin, joinCode) : `${origin}/`, `mirador-machine-${origin}`);
}

function AddMachine({ machines }: { machines: Machine[] }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const parsed = machineAddress(address);
  const known = parsed && machines.some(({ origin }) => origin === parsed.origin);

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!parsed || known || !connection.send({ type: "machine.add", name, address })) return;
    if (parsed.joinCode) openMachine(parsed.origin, parsed.joinCode);
    setName("");
    setAddress("");
  };

  return (
    <form className="add-machine" onSubmit={add}>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Home server" />
      </label>
      <label>
        Address or invite link
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="home-server.your-tailnet.ts.net"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button type="submit" className="primary" disabled={!parsed || !!known}>
        {parsed?.joinCode ? "Add and join" : "Add"}
      </button>
      {known && <p className="hint">This machine is already in the list.</p>}
    </form>
  );
}

export function MachinesDialog({ machines, onClose }: { machines: Machine[]; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal machines" role="dialog" aria-label="Machines">
        <header>
          <h2>Machines</h2>
          <button className="icon" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <p className="hint">
          Other computers running Mirador, such as a server whose agents keep working while this one sleeps. Each opens in a tab of its own. The first time, it
          asks for an invite code: run <code>bun run invite</code> on the machine, or paste the invite link here instead of its address.
        </p>
        <ul className="machine-list" aria-label="Machines">
          {machines.map((machine) => (
            <li key={machine.id}>
              <span className="machine-name">{machine.name}</span>
              <span className="machine-origin">{machine.origin}</span>
              <button type="button" onClick={() => openMachine(machine.origin)}>
                Open
              </button>
              <ConfirmButton
                className="danger"
                label={`Remove ${machine.name}`}
                armedText="Remove?"
                armedHint={hints.removeMachineArmed}
                onConfirm={() => connection.send({ type: "machine.remove", machineId: machine.id })}
              >
                Remove
              </ConfirmButton>
            </li>
          ))}
          {machines.length === 0 && <li className="machine-none">No machines yet.</li>}
        </ul>
        <AddMachine machines={machines} />
      </div>
    </div>
  );
}
