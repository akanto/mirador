import type { PlanEntry } from "@agentclientprotocol/sdk";
import { useEffect, useRef, useState } from "react";
import { checklistItems, checklistProgress, type Checklist, type ChecklistItem } from "../shared/checklist.ts";
import type { CanvasItem } from "../shared/model.ts";
import { connection } from "./connection.ts";
import { hints } from "./hints.ts";
import { MarkdownText } from "./Markdown.tsx";

export type ChecklistCanvasItem = CanvasItem & { checklist: Checklist };

const AGENT_EDIT_FLASH_MS = 2000;

const ownerLabels = { user: "you", both: "both" };

/** The conversation's checklist is the newest the agent published and has not dismissed; a new publishing brings one back. */
export const currentChecklist = (items: CanvasItem[]): ChecklistCanvasItem | undefined => {
  const newest = items.filter((item): item is ChecklistCanvasItem => item.checklist !== undefined).sort((a, b) => b.createdAt - a.createdAt)[0];
  return newest && !newest.checklist.dismissed ? newest : undefined;
};

const planAsItems = (plan: PlanEntry[]) => plan.map((entry) => ({ done: entry.status === "completed" }));

/** What the tab's toggle counts: the agent's checklist, or without one, its own plan. */
export function checklistCount(checklist: ChecklistCanvasItem | undefined, plan: PlanEntry[] | null) {
  const { done, total } = checklistProgress(checklist ? checklistItems(checklist.checklist) : planAsItems(plan ?? []));
  return `${done}/${total}`;
}

/**
 * Flashes for a moment when the agent changes the checklist, though not for the change it carried when it came: the panel
 * opens before the conversation's history arrives, and a checklist arriving with it was changed long ago.
 */
export function useFlashOnAgentEdit(checklistId: string | undefined, at: number | undefined, wanted: boolean) {
  const [flashing, setFlashing] = useState(false);
  const known = useRef({ checklistId, at });
  useEffect(() => {
    const changedSince = known.current.checklistId === checklistId && at !== undefined && at !== known.current.at;
    known.current = { checklistId, at };
    if (!changedSince || !wanted) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), AGENT_EDIT_FLASH_MS);
    return () => {
      clearTimeout(timer);
      setFlashing(false);
    };
  }, [checklistId, at]);
  return flashing;
}

/** An item the agent changed after `seenUpTo`, the change the user last saw with the tab open, flashes once. */
function useFlashForUnseenEdit(edit: Checklist["agentEdit"], itemId: string, seenUpTo: number | undefined) {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!edit || (seenUpTo !== undefined && edit.at <= seenUpTo) || !edit.items.includes(itemId)) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), AGENT_EDIT_FLASH_MS);
    return () => {
      clearTimeout(timer);
      setFlashing(false);
    };
  }, [edit?.at]);
  return flashing;
}

function ChecklistEntry({ checklistId, item, agentEdit, seenUpTo }: { checklistId: string; item: ChecklistItem; agentEdit: Checklist["agentEdit"]; seenUpTo: number | undefined }) {
  const flashing = useFlashForUnseenEdit(agentEdit, item.id, seenUpTo);
  const tick = (done: boolean) => connection.send({ type: "checklist.tick", itemId: checklistId, checklistItemId: item.id, done });
  return (
    <li className={["checklist-item", item.done && "done", flashing && "agent-edited"].filter(Boolean).join(" ")} data-item-id={item.id}>
      <label>
        <input type="checkbox" checked={item.done} onChange={(event) => tick(event.target.checked)} />
        <span className="checklist-text">{item.text}</span>
        {item.owner !== "agent" && (
          <span className={`checklist-owner owner-${item.owner}`} data-hint={hints.checklistOwner[item.owner]}>
            {ownerLabels[item.owner]}
          </span>
        )}
      </label>
      {item.detail && (
        <div className="checklist-detail">
          <MarkdownText text={item.detail} />
        </div>
      )}
    </li>
  );
}

const progressLabel = (items: { done: boolean }[]) => {
  const { done, total } = checklistProgress(items);
  return `${done}/${total}`;
};

function AgentChecklist({ item, seenUpTo }: { item: ChecklistCanvasItem; seenUpTo: number | undefined }) {
  const { sections, agentEdit } = item.checklist;
  return (
    <section className="checklist-list" aria-label={item.title}>
      {sections.map((section, index) => (
        <section key={index} className="checklist-section" aria-label={section.title ?? item.title}>
          {section.title && (
            <h4>
              {section.title} <span className="checklist-progress">{progressLabel(section.items)}</span>
            </h4>
          )}
          <ul>
            {section.items.map((entry) => (
              <ChecklistEntry key={entry.id} checklistId={item.id} item={entry} agentEdit={agentEdit} seenUpTo={seenUpTo} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function PinnedPlan({ plan }: { plan: PlanEntry[] }) {
  return (
    <section className="checklist-section checklist-plan" aria-label="Agent's plan">
      <h4 data-hint={hints.checklistPlan}>
        Agent's plan <span className="checklist-progress">{progressLabel(planAsItems(plan))}</span>
      </h4>
      <ul>
        {plan.map((entry, index) => (
          <li key={index} className={["checklist-item", entry.status === "completed" && "done", `plan-${entry.status}`].filter(Boolean).join(" ")}>
            <label>
              <input type="checkbox" checked={entry.status === "completed"} disabled />
              <span className="checklist-text">{entry.content}</span>
              {entry.status === "in_progress" && <span className="checklist-owner">in progress</span>}
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Covers the canvas like Changes: the agent's checklist, and under it the plan the agent keeps for itself. */
export function ChecklistView({ checklist, plan, seenEditAt }: { checklist: ChecklistCanvasItem | undefined; plan: PlanEntry[] | null; seenEditAt: number | undefined }) {
  const [seenUpTo] = useState(seenEditAt);
  return (
    <div className="checklist">
      {checklist && <AgentChecklist item={checklist} seenUpTo={seenUpTo} />}
      {plan && <PinnedPlan plan={plan} />}
    </div>
  );
}
