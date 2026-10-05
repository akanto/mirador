import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { canvasUseLabels, type CanvasUse, type ClaudeProgram, type PromptTemplate } from "../shared/model.ts";
import { shellOutputStyleLabels } from "../shared/shell-output.ts";
import { MachineColorPreview, ShellOutputPreview, ThemePreview, WaitingPreview, WorkspaceColorPreview } from "./appearance-previews.tsx";
import { enterWhileBusyLabels, setEnterWhileBusy, useEnterWhileBusy, type EnterWhileBusy } from "./busy-sending.ts";
import { connection } from "./connection.ts";
import { inDesktopApp } from "./desktop-bridge.ts";
import { DeviceSettings } from "./Devices.tsx";
import { reviewPlacementLabels, setReviewPlacement, useReviewPlacement, type ReviewPlacement } from "./review-placement.ts";
import { hints } from "./hints.ts";
import { machineColorStyleLabels, setMachineColorStyle, useMachineColorStyle } from "./machine-colors.ts";
import { PromptTemplateSettings } from "./PromptTemplates.tsx";
import { arrangements, paneLabels, sameSlots, type HideablePane, type LayoutDefault, type PaneId, type Slots } from "./layout.ts";
import { setShellOutputStyle, useShellOutputStyle } from "./shell-output.ts";
import { isMac } from "./shortcuts.ts";
import type { DevicesListed, SettingsPage } from "./state.ts";
import { notifies, setNotificationsWanted, useNotificationSetting, type NotificationSetting } from "./system-notifications.ts";
import { themeLabels, useTheme } from "./theme.ts";
import { setCopyOnSelect, useCopyOnSelect } from "./terminal-settings.ts";
import { useTimestampsShown } from "./timestamps.ts";
import { setTypingAids, useTypingAids, type TypingAids } from "./typing-aids.ts";
import { useWaitingStyle, waitingStyleLabels } from "./waiting.ts";
import { setWorkspaceColorStyle, useWorkspaceColorStyle, workspaceColorStyleLabels } from "./workspace-colors.ts";

const thumbnailLabels: Record<PaneId, string> = { conversation: "Chat", canvas: "Canvas", terminals: "Terminals" };
const startHiddenLabels: Record<HideablePane, string> = { canvas: "Canvas starts hidden", terminals: "Terminals start hidden" };

const typingAidLabels: Record<keyof TypingAids, string> = {
  autocorrect: "Correct spelling automatically",
  predictions: "Inline predictions",
};

const describe = ([left, top, bottom]: Slots) =>
  `${paneLabels[left]} on the left, ${paneLabels[top].toLowerCase()} top right, ${paneLabels[bottom].toLowerCase()} bottom right`;

function Thumbnail({ slots, hidden }: { slots: Slots; hidden: LayoutDefault["hidden"] }) {
  const isHidden = (pane: PaneId) => pane !== "conversation" && hidden[pane];
  return (
    <span className="layout-thumbnail" aria-hidden="true">
      {slots.map((pane, index) => (
        <span key={pane} className={`layout-thumbnail-pane slot-${index} pane-${pane} ${isHidden(pane) ? "starts-hidden" : ""}`}>
          {thumbnailLabels[pane]}
        </span>
      ))}
    </span>
  );
}

const pageLabels: Record<SettingsPage, string> = {
  appearance: "Appearance",
  conversations: "Conversations",
  agents: "Agents",
  terminal: "Terminal",
  canvas: "Canvas",
  layout: "Layout",
  devices: "Devices",
  notifications: "Notifications",
};
const settingsPages = Object.keys(pageLabels) as SettingsPage[];
const pageSteps: Partial<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowUp: -1 };

export function SettingsDialog({
  page: openedAt,
  devices,
  promptTemplates,
  canvasUse,
  claudeProgram,
  layoutDefault,
  onChange,
  onClose,
}: {
  page: SettingsPage | undefined;
  devices: DevicesListed | null;
  promptTemplates: PromptTemplate[];
  canvasUse: CanvasUse;
  claudeProgram: ClaudeProgram;
  layoutDefault: LayoutDefault;
  onChange: (layoutDefault: LayoutDefault) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>(openedAt ?? "appearance");
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const pages: Record<SettingsPage, () => ReactNode> = {
    appearance: () => <AppearanceSettings />,
    conversations: () => (
      <>
        <SendingSettings />
        <PromptTemplateSettings templates={promptTemplates} />
        {isMac && <TypingSettings />}
      </>
    ),
    agents: () => <AgentSettings claudeProgram={claudeProgram} />,
    terminal: () => <TerminalSettings />,
    canvas: () => (
      <>
        <CanvasSettings canvasUse={canvasUse} />
        <ReviewSettings />
      </>
    ),
    layout: () => <LayoutSettings layoutDefault={layoutDefault} onChange={onChange} />,
    devices: () => <DeviceSettings listed={devices} />,
    notifications: () => <NotificationSettings />,
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button className="icon" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="settings-body">
          <PageList page={page} onChoose={setPage} />
          <div className="settings-page" role="tabpanel" id="settings-page" aria-labelledby={`settings-tab-${page}`}>
            {pages[page]()}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Up and Down move between the pages, as in a list of tabs. */
function PageList({ page, onChoose }: { page: SettingsPage; onChoose: (page: SettingsPage) => void }) {
  const chooseWithArrows = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = pageSteps[event.key];
    if (!step) return;
    event.preventDefault();
    const next = settingsPages[(settingsPages.indexOf(page) + step + settingsPages.length) % settingsPages.length]!;
    onChoose(next);
    event.currentTarget.querySelector<HTMLElement>(`#settings-tab-${next}`)?.focus();
  };
  return (
    <nav className="settings-pages" role="tablist" aria-orientation="vertical" aria-label="Settings pages" onKeyDown={chooseWithArrows}>
      {settingsPages.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`settings-tab-${id}`}
          aria-selected={id === page}
          aria-controls="settings-page"
          tabIndex={id === page ? 0 : -1}
          onClick={() => onChoose(id)}
        >
          {pageLabels[id]}
        </button>
      ))}
    </nav>
  );
}

function LayoutSettings({ layoutDefault, onChange }: { layoutDefault: LayoutDefault; onChange: (layoutDefault: LayoutDefault) => void }) {
  const startHidden = (pane: HideablePane, hidden: boolean) => onChange({ ...layoutDefault, hidden: { ...layoutDefault.hidden, [pane]: hidden } });
  return (
    <>
      <h3>Default layout</h3>
      <p className="hint">
        New conversations start with it, and so do those whose panes you haven't moved, resized, hidden or made fullscreen.{" "}
        <em>Reset layout to default</em> in the palette brings the open conversation back to it.
      </p>
      <div className="arrangements" role="radiogroup" aria-label="Default arrangement">
        {arrangements.map((slots) => {
          const chosen = sameSlots(slots, layoutDefault.slots);
          return (
            <button
              key={slots.join()}
              type="button"
              role="radio"
              aria-checked={chosen}
              aria-label={describe(slots)}
              className={`arrangement ${chosen ? "chosen" : ""}`}
              onClick={() => onChange({ ...layoutDefault, slots })}
            >
              <Thumbnail slots={slots} hidden={layoutDefault.hidden} />
            </button>
          );
        })}
      </div>
      <div className="start-hidden">
        {(["canvas", "terminals"] as const).map((pane) => (
          <label key={pane}>
            <input type="checkbox" checked={layoutDefault.hidden[pane]} onChange={(event) => startHidden(pane, event.target.checked)} />
            {startHiddenLabels[pane]}
          </label>
        ))}
      </div>
    </>
  );
}

/** A choice between looks, each option a small picture of how the app looks with it. */
function PictureChoice<Option extends string>({
  name,
  hint,
  labels,
  chosen,
  onChoose,
  preview,
}: {
  name: string;
  hint: string;
  labels: Record<Option, string>;
  chosen: Option;
  onChoose: (option: Option) => void;
  preview: (option: Option) => ReactNode;
}) {
  return (
    <div className="picture-choice" data-hint={hint}>
      <div className="picture-choice-name">{name}</div>
      <div className="picture-options" role="radiogroup" aria-label={name}>
        {(Object.keys(labels) as Option[]).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={option === chosen}
            className={`picture-option ${option === chosen ? "chosen" : ""}`}
            onClick={() => onChoose(option)}
          >
            <span className="picture-preview" aria-hidden="true">
              {preview(option)}
            </span>
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

function AppearanceSettings() {
  const [theme, setTheme] = useTheme();
  const [timestampsShown, setTimestampsShown] = useTimestampsShown();
  const [waitingStyle, setWaitingStyle] = useWaitingStyle();
  const workspaceColorStyle = useWorkspaceColorStyle();
  const machineColorStyle = useMachineColorStyle();
  const shellOutputStyle = useShellOutputStyle();
  return (
    <>
      <h3>Appearance</h3>
      <p className="hint">Remembered in this browser.</p>
      <PictureChoice name="Theme" hint={hints.theme} labels={themeLabels} chosen={theme} onChoose={setTheme} preview={(option) => <ThemePreview theme={option} />} />
      <PictureChoice
        name="Waiting for you"
        hint={hints.waitingStyle}
        labels={waitingStyleLabels}
        chosen={waitingStyle}
        onChoose={setWaitingStyle}
        preview={(option) => <WaitingPreview style={option} />}
      />
      <PictureChoice
        name="Workspace colours"
        hint={hints.workspaceColorStyle}
        labels={workspaceColorStyleLabels}
        chosen={workspaceColorStyle}
        onChoose={setWorkspaceColorStyle}
        preview={(option) => <WorkspaceColorPreview style={option} />}
      />
      <PictureChoice
        name="Machine colours"
        hint={hints.machineColorStyle}
        labels={machineColorStyleLabels}
        chosen={machineColorStyle}
        onChoose={setMachineColorStyle}
        preview={(option) => <MachineColorPreview style={option} />}
      />
      <PictureChoice
        name="Shell commands"
        hint={hints.shellOutputStyle}
        labels={shellOutputStyleLabels}
        chosen={shellOutputStyle}
        onChoose={setShellOutputStyle}
        preview={(option) => <ShellOutputPreview style={option} />}
      />
      <div className="appearance-settings">
        <label data-hint={hints.timestamps}>
          <input type="checkbox" checked={timestampsShown} onChange={(event) => setTimestampsShown(event.target.checked)} />
          Show timestamps
        </label>
      </div>
    </>
  );
}

function SendingSettings() {
  const enterWhileBusy = useEnterWhileBusy();
  return (
    <>
      <h3>Sending while the agent works</h3>
      <p className="hint">⌥Enter (Alt+Enter) does the other; each queued message shows which way it goes out. Remembered in this browser.</p>
      <div className="sending-settings">
        <label data-hint={hints.enterWhileBusy}>
          Enter
          <select value={enterWhileBusy} onChange={(event) => setEnterWhileBusy(event.target.value as EnterWhileBusy)}>
            {Object.entries(enterWhileBusyLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}

function TerminalSettings() {
  const copyOnSelect = useCopyOnSelect();
  return (
    <>
      <h3>Terminal</h3>
      <p className="hint">Remembered in this browser.</p>
      <div className="terminal-settings">
        <label data-hint={hints.copyOnSelect}>
          <input type="checkbox" checked={copyOnSelect} onChange={(event) => setCopyOnSelect(event.target.checked)} />
          Copy on select
        </label>
      </div>
    </>
  );
}

function foundClaudeProgram({ configured, found, version }: ClaudeProgram) {
  if (found) return version ? `Runs ${found}, ${version}` : `Runs ${found}`;
  if (configured) return "Nothing at that path can run.";
  return "Claude Code is not installed. Install it with curl -fsSL https://claude.ai/install.sh | bash, or enter where its claude program is.";
}

function AgentSettings({ claudeProgram }: { claudeProgram: ClaudeProgram }) {
  const [path, setPath] = useState(claudeProgram.configured);
  useEffect(() => setPath(claudeProgram.configured), [claudeProgram.configured]);
  const save = () => {
    if (path.trim() !== claudeProgram.configured) connection.send({ type: "settings.set-claude-program", path: path.trim() });
  };
  return (
    <>
      <h3>Claude Code</h3>
      <p className="hint">
        Mirador runs the Claude Code installed on the host's computer. A change restarts its agents, which stops the turns they are running.
      </p>
      <div className="sending-settings">
        <label data-hint={hints.claudeProgram}>
          Program
          <input
            type="text"
            className="claude-program"
            value={path}
            placeholder="Found on its own"
            spellCheck={false}
            onChange={(event) => setPath(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => event.key === "Enter" && save()}
          />
        </label>
      </div>
      <p className="hint claude-program-found" role="status">
        {foundClaudeProgram(claudeProgram)}
      </p>
    </>
  );
}

function CanvasSettings({ canvasUse }: { canvasUse: CanvasUse }) {
  return (
    <>
      <h3>Canvas</h3>
      <p className="hint">
        Kept by the host for every browser. A conversation picks up a change when its session next starts: a new one at once, an open one after the host
        restarts. Claude Code only; opencode follows the canvas's own instructions.
      </p>
      <div className="sending-settings">
        <label data-hint={hints.canvasUse}>
          Claude Code uses the canvas
          <select value={canvasUse} onChange={(event) => connection.send({ type: "settings.set-canvas-use", canvasUse: event.target.value as CanvasUse })}>
            {Object.entries(canvasUseLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}

function ReviewSettings() {
  const placement = useReviewPlacement();
  return (
    <>
      <h3>Code reviews</h3>
      <p className="hint">The button in a review's bar switches between the two at any time. Remembered in this browser.</p>
      <div className="sending-settings">
        <label data-hint={hints.reviewPlacementSetting}>
          Open reviews
          <select value={placement} onChange={(event) => setReviewPlacement(event.target.value as ReviewPlacement)}>
            {Object.entries(reviewPlacementLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
}

const WHEN_NOTIFIED = "when a conversation you're not looking at asks a question or for permission, finishes its turn, or stops with an error";

const blockedNotice: Partial<Record<NotificationSetting["permission"], string>> = {
  denied: "This browser blocks notifications from Mirador. Allow them in its settings for this site, then switch them on here.",
  unsupported: "This browser can't show notifications.",
};

function NotificationSettings() {
  const setting = useNotificationSetting();
  if (inDesktopApp()) {
    return (
      <>
        <h3>Notifications</h3>
        <p className="hint">The desktop app notifies you {WHEN_NOTIFIED}, also while its window is closed.</p>
      </>
    );
  }
  const notice = blockedNotice[setting.permission];
  return (
    <>
      <h3>Notifications</h3>
      <p className="hint">
        This browser notifies you {WHEN_NOTIFIED}; click one to open the conversation. While the desktop app runs on this computer, it notifies instead.
      </p>
      <div className="notification-settings">
        <label>
          <input
            type="checkbox"
            checked={notifies(setting)}
            disabled={setting.permission === "unsupported"}
            onChange={(event) => void setNotificationsWanted(event.target.checked)}
          />
          Notify me in this browser
        </label>
      </div>
      {notice && <p className="hint">{notice}</p>}
    </>
  );
}

function TypingSettings() {
  const typingAids = useTypingAids();
  return (
    <>
      <h3>Typing</h3>
      <p className="hint">
        What macOS may do to your words in the desktop app: fix them as you type a space, and offer the rest of a word in grey.
        Misspellings stay underlined either way; right-click one to fix it.
      </p>
      <div className="typing-aids">
        {(["autocorrect", "predictions"] as const).map((aid) => (
          <label key={aid}>
            <input type="checkbox" checked={typingAids[aid]} onChange={(event) => setTypingAids({ ...typingAids, [aid]: event.target.checked })} />
            {typingAidLabels[aid]}
          </label>
        ))}
      </div>
    </>
  );
}
