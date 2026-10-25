import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PluginItemContext, PluginViewBridge } from "../../shared/canvas-document.ts";
import type { PluginItem } from "../../shared/canvas-plugins.ts";
import { hints } from "../../web/hints.ts";
import { ExternalImagesBlocked, MarkdownText } from "../../web/Markdown.tsx";
import { checklistProgress, type Checklist, type ChecklistItem } from "./checklist.ts";
import viewStyles from "./view.css" with { type: "text" };

declare global {
  interface Window {
    mirador: PluginViewBridge<Checklist>;
  }
}

const AGENT_EDIT_FLASH_MS = 2000;

const ownerLabels = { user: "you", both: "both" };

/** The agent's latest change, as the view needs it to flash what it touched. */
interface AgentChange {
  at: number | null;
  items: string[];
}

/** An item the agent changed after `seenUpTo`, the change the user last saw with the tab open, flashes once. */
function useFlashForUnseenChange({ at, items }: AgentChange, itemId: string, seenUpTo: number | null) {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (at === null || (seenUpTo !== null && at <= seenUpTo) || !items.includes(itemId)) return;
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), AGENT_EDIT_FLASH_MS);
    return () => {
      clearTimeout(timer);
      setFlashing(false);
    };
  }, [at]);
  return flashing;
}

function ChecklistEntry({ item, agentChange, seenUpTo }: { item: ChecklistItem; agentChange: AgentChange; seenUpTo: number | null }) {
  const flashing = useFlashForUnseenChange(agentChange, item.id, seenUpTo);
  const tick = (done: boolean) => void window.mirador.send({ kind: "tick", itemId: item.id, done });
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

function AgentChecklist({ item, context }: { item: PluginItem<Checklist>; context: PluginItemContext }) {
  const { sections, agentChanged = [] } = item.data;
  const agentChange = { at: item.agentEditedAt, items: agentChanged };
  return (
    <ExternalImagesBlocked.Provider value={!context.imagesFromOtherSites}>
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
                <ChecklistEntry key={entry.id} item={entry} agentChange={agentChange} seenUpTo={context.seenAgentEditAt} />
              ))}
            </ul>
          </section>
        ))}
      </section>
    </ExternalImagesBlocked.Provider>
  );
}

function ChecklistPage() {
  const [shown, setShown] = useState<{ item: PluginItem<Checklist>; context: PluginItemContext }>();
  useEffect(() => window.mirador.onItem((item, context) => setShown({ item, context })), []);
  return shown ? <AgentChecklist item={shown.item} context={shown.context} /> : null;
}

const style = document.createElement("style");
style.textContent = viewStyles;
document.head.append(style);
const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(<ChecklistPage />);
