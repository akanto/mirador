import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { PluginUpdate } from "../shared/apps.ts";
import { canvasUseLabels, type CanvasUse, type ClaudeProgram, type Profile, type PromptTemplate } from "../shared/model.ts";
import type { VoiceSettings as VoiceSettingsValue } from "../shared/voice.ts";
import type { VoiceEngineStatus } from "../shared/voice-engine.ts";
import { shellOutputStyleLabels } from "../shared/shell-output.ts";
import type { NewerVersion } from "../shared/newer-version.ts";
import { FontSizePreview, MachineColorPreview, ShellLookPreview, ShellOutputPreview, ThemePreview, WaitingPreview, WorkspaceColorPreview } from "./appearance-previews.tsx";
import { enterWhileBusyLabels, setEnterWhileBusy, useEnterWhileBusy, type EnterWhileBusy } from "./busy-sending.ts";
import { connection } from "./connection.ts";
import { inDesktopApp } from "./desktop-bridge.ts";
import { DeviceSettings } from "./Devices.tsx";
import { PluginSettings, UpdatesWaiting } from "./PluginSettings.tsx";
import { externalImages, setExternalImages, useExternalImagesBlocked } from "./external-images.ts";
import { setEditsInCanvas, useEditsInCanvas } from "./edits-in-canvas.ts";
import { fontScaleLabels, useFontScale } from "./font-scale.ts";
import { pageLibrariesLabels, type PageLibraries } from "../shared/canvas-export.ts";
import { setPageLibraries, usePageLibraries } from "./page-libraries.ts";
import { rememberSettingsSize } from "./paneLayouts.ts";
import { hints } from "./hints.ts";
import { NewerVersionNote, UpdateCheckButton } from "./NewerVersion.tsx";
import { machineColorStyleLabels, setMachineColorStyle, useMachineColorStyle } from "./machine-colors.ts";
import { profilePictureDataUrl } from "./profile-picture.ts";
import { PromptTemplateSettings } from "./PromptTemplates.tsx";
import { arrangements, paneLabels, sameSlots, type HideablePane, type LayoutDefault, type PaneId, type Slots } from "./layout.ts";
import {
  changeShellAppearance,
  DEFAULT_CUSTOM_SHELL_COLOURS,
  DEFAULT_SHELL_APPEARANCE,
  isFontFamily,
  shellColourLabels,
  shellFontSizeLabels,
  shellLookLabels,
  useShellAppearance,
  type ShellColours,
  type ShellFontSize,
} from "./shell-look.ts";
import { setShellOutputStyle, useShellOutputStyle } from "./shell-output.ts";
import { isMac } from "./shortcuts.ts";
import type { DevicesListed, SettingsPage } from "./state.ts";
import { notifies, setNotificationsWanted, useNotificationSetting, type NotificationSetting } from "./system-notifications.ts";
import {
  cursorStyleLabels,
  resetTerminalSettings,
  setCopyOnSelect,
  setTerminalSettings,
  TERMINAL_FONT_SIZES,
  TERMINAL_FONT_WEIGHTS_BOLD,
  TERMINAL_LETTER_SPACINGS,
  TERMINAL_LINE_HEIGHTS,
  TERMINAL_SCROLLBACKS,
  terminalFontList,
  terminalPresetLabels,
  useTerminalSettings,
  type TerminalCursorStyle,
  type TerminalPreset,
} from "./terminal-settings.ts";
import { themeLabels, useTheme } from "./theme.ts";
import { usePulsesOn } from "./pulses.ts";
import { VoiceSettings } from "./VoiceSettings.tsx";
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
  voice: "Voice",
  terminal: "Terminal",
  canvas: "Canvas",
  plugins: "Plugins",
  layout: "Layout",
  devices: "Devices",
  notifications: "Notifications",
  about: "About",
};
const settingsPages = Object.keys(pageLabels) as SettingsPage[];
const pageSteps: Partial<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowUp: -1 };

export function SettingsDialog({
  page: openedAt,
  devices,
  promptTemplates,
  canvasUse,
  claudeProgram,
  scriptProgram,
  avatar,
  voiceSettings,
  voiceEngine,
  profiles,
  version,
  newerVersion,
  pluginUpdates,
  layoutDefault,
  onChange,
  onClose,
}: {
  page: SettingsPage | undefined;
  devices: DevicesListed | null;
  promptTemplates: PromptTemplate[];
  canvasUse: CanvasUse;
  claudeProgram: ClaudeProgram;
  scriptProgram: string;
  avatar: string | null;
  voiceSettings: VoiceSettingsValue;
  voiceEngine: VoiceEngineStatus;
  profiles: Profile[];
  version: string;
  newerVersion: NewerVersion | null;
  pluginUpdates: PluginUpdate[];
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
    appearance: () => (
      <>
        <ProfilePictureSettings picture={avatar} />
        <AppearanceSettings />
      </>
    ),
    conversations: () => (
      <>
        <SendingSettings />
        <PromptTemplateSettings templates={promptTemplates} />
        <ExternalImageSettings />
        <FileLinkSettings scriptProgram={scriptProgram} />
        {isMac && <TypingSettings />}
      </>
    ),
    agents: () => <AgentSettings claudeProgram={claudeProgram} />,
    voice: () => <VoiceSettings settings={voiceSettings} engine={voiceEngine} profiles={profiles} />,
    terminal: () => <TerminalSettings />,
    canvas: () => (
      <>
        <CanvasSettings canvasUse={canvasUse} />
        <EditApprovalSettings />
        <SavedPageSettings />
      </>
    ),
    plugins: () => <PluginSettings pluginUpdates={pluginUpdates} />,
    layout: () => <LayoutSettings layoutDefault={layoutDefault} onChange={onChange} />,
    devices: () => <DeviceSettings listed={devices} />,
    notifications: () => <NotificationSettings />,
    about: () => <AboutSettings version={version} newerVersion={newerVersion} claudeProgram={claudeProgram} />,
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-label="Settings" ref={rememberSettingsSize}>
        <header>
          <h2>Settings</h2>
          <button className="icon" title="Close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="settings-body">
          <PageList page={page} onChoose={setPage} pluginUpdates={pluginUpdates.length} />
          <div className="settings-page" role="tabpanel" id="settings-page" aria-labelledby={`settings-tab-${page}`}>
            {pages[page]()}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Up and Down move between the pages, as in a list of tabs. */
function PageList({ page, onChoose, pluginUpdates }: { page: SettingsPage; onChoose: (page: SettingsPage) => void; pluginUpdates: number }) {
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
          {id === "plugins" && <UpdatesWaiting count={pluginUpdates} />}
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
  columns,
  onChoose,
  preview,
}: {
  name: string;
  hint: string;
  labels: Record<Option, string>;
  chosen: Option;
  columns?: number;
  onChoose: (option: Option) => void;
  preview: (option: Option) => ReactNode;
}) {
  return (
    <div className="picture-choice" data-hint={hint}>
      <div className="picture-choice-name">{name}</div>
      <div
        className="picture-options"
        role="radiogroup"
        aria-label={name}
        style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
      >
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

function ProfilePictureSettings({ picture }: { picture: string | null }) {
  const [refusal, setRefusal] = useState("");
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      connection.send({ type: "settings.set-avatar", image: await profilePictureDataUrl(file) });
      setRefusal("");
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section data-hint={hints.profilePicture}>
      <h3>Profile picture</h3>
      <p className="hint">Next to your messages, kept by the host for every browser and device that joins it.</p>
      <div className="profile-picture">
        {picture && <img className="profile-picture-preview" src={picture} alt="" />}
        <input
          type="file"
          accept="image/*"
          aria-label="Profile picture"
          onChange={(event) => {
            void chooseFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {picture && <button type="button" onClick={() => connection.send({ type: "settings.set-avatar", image: null })}>Remove</button>}
        {refusal && (
          <p className="hint profile-picture-refused" role="alert">
            {refusal}
          </p>
        )}
      </div>
    </section>
  );
}

function AppearanceSettings() {
  const [theme, setTheme] = useTheme();
  const [timestampsShown, setTimestampsShown] = useTimestampsShown();
  const [pulsesOn, setPulsesOn] = usePulsesOn();
  const [fontScale, setFontScale] = useFontScale();
  const [waitingStyle, setWaitingStyle] = useWaitingStyle();
  const workspaceColorStyle = useWorkspaceColorStyle();
  const machineColorStyle = useMachineColorStyle();
  const shellOutputStyle = useShellOutputStyle();
  const shellAppearance = useShellAppearance();
  return (
    <>
      <h3>Appearance</h3>
      <p className="hint">Remembered in this browser.</p>
      <PictureChoice
        name="Text size"
        hint={hints.textSize}
        labels={fontScaleLabels}
        chosen={fontScale}
        columns={5}
        onChoose={setFontScale}
        preview={(option) => <FontSizePreview scale={option} />}
      />
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
      <PictureChoice
        name="Shell colours"
        hint={hints.shellLook}
        labels={shellLookLabels}
        chosen={shellAppearance.look}
        columns={5}
        onChoose={(look) => changeShellAppearance({ look })}
        preview={(look) => <ShellLookPreview look={look} />}
      />
      <ShellLookSettings />
      <div className="appearance-settings">
        <label data-hint={hints.timestamps}>
          <input type="checkbox" checked={timestampsShown} onChange={(event) => setTimestampsShown(event.target.checked)} />
          Show timestamps
        </label>
        <label data-hint={hints.pulses}>
          <input type="checkbox" checked={pulsesOn} onChange={(event) => setPulsesOn(event.target.checked)} />
          Pulse status dots
        </label>
      </div>
    </>
  );
}

function ShellLookSettings() {
  const { look, custom, font, size } = useShellAppearance();
  const [fontTyped, setFontTyped] = useState(font);
  const fontRefused = fontTyped.trim() !== "" && !isFontFamily(fontTyped);
  const typeFont = (typed: string) => {
    setFontTyped(typed);
    changeShellAppearance({ font: typed });
  };
  const fontAsDefault = font === DEFAULT_SHELL_APPEARANCE.font && size === DEFAULT_SHELL_APPEARANCE.size;
  return (
    <div className="appearance-settings shell-look-settings">
      {look === "custom" && (
        <div className="shell-colours">
          {(Object.keys(shellColourLabels) as (keyof ShellColours)[]).map((part) => (
            <label key={part}>
              <input type="color" value={custom[part]} onChange={(event) => changeShellAppearance({ custom: { ...custom, [part]: event.target.value } })} />
              {shellColourLabels[part]}
            </label>
          ))}
          <button type="button" className="link" onClick={() => changeShellAppearance({ custom: DEFAULT_CUSTOM_SHELL_COLOURS })}>
            Reset colours
          </button>
        </div>
      )}
      <label data-hint={hints.shellFont}>
        Shell font
        <input type="text" value={fontTyped} placeholder="Monospace" spellCheck={false} aria-invalid={fontRefused} onChange={(event) => typeFont(event.target.value)} />
      </label>
      <label data-hint={hints.shellFontSize}>
        Shell text size
        <select value={size} onChange={(event) => changeShellAppearance({ size: event.target.value as ShellFontSize })}>
          {Object.entries(shellFontSizeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="link"
        disabled={fontAsDefault}
        onClick={() => {
          setFontTyped(DEFAULT_SHELL_APPEARANCE.font);
          changeShellAppearance({ font: DEFAULT_SHELL_APPEARANCE.font, size: DEFAULT_SHELL_APPEARANCE.size });
        }}
      >
        Reset font
      </button>
      {fontRefused && <p className="hint shell-font-refused">A font name takes letters, digits, spaces, quotes, commas, dots and hyphens.</p>}
    </div>
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

const TERMINAL_FONT_PREVIEW = "Sample text — 0O 1l {} () <>";

const trimmed = (value: number) => value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

function TerminalSettings() {
  const settings = useTerminalSettings();
  const [fontTyped, setFontTyped] = useState(settings.fontFamily);
  useEffect(() => setFontTyped(settings.fontFamily), [settings.fontFamily]);
  const fontRefused = fontTyped.trim() !== "" && !isFontFamily(fontTyped);
  const typeFont = (typed: string) => {
    setFontTyped(typed);
    if (typed.trim() === "" || isFontFamily(typed)) setTerminalSettings({ fontFamily: typed });
  };
  return (
    <>
      <h3>Terminal</h3>
      <p className="hint">Remembered in this browser.</p>
      <div className="terminal-settings">
        <label data-hint={hints.terminalPreset}>
          Colour preset
          <select value={settings.preset} onChange={(event) => setTerminalSettings({ preset: event.target.value as TerminalPreset })}>
            {Object.entries(terminalPresetLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label data-hint={hints.terminalFontFamily}>
          Font
          <input
            type="text"
            className="terminal-font"
            value={fontTyped}
            placeholder="The usual Nerd Fonts"
            spellCheck={false}
            aria-invalid={fontRefused}
            onChange={(event) => typeFont(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="link"
          disabled={settings.fontFamily === ""}
          onClick={() => {
            setFontTyped("");
            setTerminalSettings({ fontFamily: "" });
          }}
        >
          Reset font
        </button>
        <div className="terminal-font-preview" aria-hidden="true" style={{ fontFamily: terminalFontList(settings.fontFamily) }}>
          {TERMINAL_FONT_PREVIEW}
        </div>
        {fontRefused && <p className="hint terminal-font-refused">A font name takes letters, digits, spaces, quotes, commas, dots and hyphens.</p>}
        <label data-hint={hints.terminalFontSize}>
          Font size
          <select value={settings.fontSize} onChange={(event) => setTerminalSettings({ fontSize: Number(event.target.value) })}>
            {TERMINAL_FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
        <label data-hint={hints.terminalLineHeight}>
          Line height
          <input
            type="range"
            min={TERMINAL_LINE_HEIGHTS.min}
            max={TERMINAL_LINE_HEIGHTS.max}
            step={TERMINAL_LINE_HEIGHTS.step}
            value={settings.lineHeight}
            onChange={(event) => setTerminalSettings({ lineHeight: Number(event.target.value) })}
          />
          <span className="terminal-setting-value" aria-hidden="true">{trimmed(settings.lineHeight)}×</span>
        </label>
        <label data-hint={hints.terminalLetterSpacing}>
          Letter spacing
          <input
            type="range"
            min={TERMINAL_LETTER_SPACINGS.min}
            max={TERMINAL_LETTER_SPACINGS.max}
            step={TERMINAL_LETTER_SPACINGS.step}
            value={settings.letterSpacing}
            onChange={(event) => setTerminalSettings({ letterSpacing: Number(event.target.value) })}
          />
          <span className="terminal-setting-value" aria-hidden="true">{trimmed(settings.letterSpacing)} px</span>
        </label>
        <label data-hint={hints.terminalCursorStyle}>
          Cursor style
          <select value={settings.cursorStyle} onChange={(event) => setTerminalSettings({ cursorStyle: event.target.value as TerminalCursorStyle })}>
            {Object.entries(cursorStyleLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label data-hint={hints.terminalCursorBlink}>
          <input type="checkbox" checked={settings.cursorBlink} onChange={(event) => setTerminalSettings({ cursorBlink: event.target.checked })} />
          Cursor blink
        </label>
        <label data-hint={hints.terminalFontWeightBold}>
          Bold weight
          <select value={settings.fontWeightBold} onChange={(event) => setTerminalSettings({ fontWeightBold: Number(event.target.value) })}>
            {TERMINAL_FONT_WEIGHTS_BOLD.map((weight) => (
              <option key={weight} value={weight}>
                {weight}
              </option>
            ))}
          </select>
        </label>
        <label data-hint={hints.terminalScrollback}>
          Scrollback
          <select value={settings.scrollback} onChange={(event) => setTerminalSettings({ scrollback: Number(event.target.value) })}>
            {TERMINAL_SCROLLBACKS.map((lines) => (
              <option key={lines} value={lines}>
                {lines.toLocaleString("en-US")} lines
              </option>
            ))}
          </select>
        </label>
        <label data-hint={hints.copyOnSelect}>
          <input type="checkbox" checked={settings.copyOnSelect} onChange={(event) => setCopyOnSelect(event.target.checked)} />
          Copy on select
        </label>
        <button type="button" className="link" onClick={resetTerminalSettings}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

function AboutSettings({ version, newerVersion, claudeProgram }: { version: string; newerVersion: NewerVersion | null; claudeProgram: ClaudeProgram }) {
  return (
    <>
      <h3>About</h3>
      <p className="hint">Mirador {version}</p>
      <NewerVersionNote newerVersion={newerVersion} />
      <UpdateCheckButton version={version} newerVersion={newerVersion} />
      <p className="hint">Claude Code: {foundClaudeProgram(claudeProgram)}</p>
    </>
  );
}

function foundClaudeProgram({ configured, found, version, installCommand }: ClaudeProgram) {
  if (found) return version ? `Runs ${found}, ${version}` : `Runs ${found}`;
  if (configured) return "Nothing at that path can run.";
  return `Claude Code is not installed. Install it with ${installCommand}, or enter where its claude program is.`;
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
        <label data-hint={hints.claudeProgram(claudeProgram.installFolders)}>
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
        restarts. Claude Code and pi; opencode follows the canvas's own instructions.
      </p>
      <div className="sending-settings">
        <label data-hint={hints.canvasUse}>
          Claude Code and pi use the canvas
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

function SavedPageSettings() {
  const libraries = usePageLibraries();
  return (
    <>
      <h3>Copied and saved pages</h3>
      <p className="hint">For a page you copy, download or save to the project from the canvas. Remembered in this browser.</p>
      <div className="sending-settings">
        <label data-hint={hints.pageLibrariesSetting}>
          Libraries
          <select value={libraries} onChange={(event) => setPageLibraries(event.target.value as PageLibraries)}>
            {Object.entries(pageLibrariesLabels).map(([value, label]) => (
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

function EditApprovalSettings() {
  const editsInCanvas = useEditsInCanvas();
  return (
    <>
      <h3>Edit approvals</h3>
      <p className="hint">When the agent asks to edit or write a file. With the canvas pane hidden, the chat shows the diff either way. Remembered in this browser.</p>
      <div className="sending-settings">
        <label data-hint={hints.editsInCanvasSetting}>
          <input type="checkbox" checked={editsInCanvas} onChange={(event) => setEditsInCanvas(event.target.checked)} />
          Show edits waiting for approval in the canvas
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

function ExternalImageSettings() {
  const choice = externalImages.use();
  const stillBlocked = useExternalImagesBlocked();
  return (
    <>
      <h3>Images from other sites</h3>
      <p className="hint">
        An agent's reply can show an image from any site. Loading it tells that site the image's address, which an agent misled by
        what it read can fill with what it read. Remembered in this browser.
      </p>
      <div className="external-images">
        <label>
          <input type="checkbox" checked={choice === "blocked"} onChange={(event) => setExternalImages(event.target.checked ? "blocked" : "shown")} />
          Show images from other sites as links
        </label>
      </div>
      {choice === "shown" && stillBlocked && (
        <p className="hint">
          They load after a reload.{" "}
          <button type="button" className="link" onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      )}
    </>
  );
}

type ScriptOpener = "text-editor" | "program";

const scriptOpenerLabels: Record<ScriptOpener, string> = { "text-editor": "The system's text editor", program: "A program you name" };

function FileLinkSettings({ scriptProgram }: { scriptProgram: string }) {
  const [opener, setOpener] = useState<ScriptOpener>(scriptProgram ? "program" : "text-editor");
  const [program, setProgram] = useState(scriptProgram);
  useEffect(() => {
    setOpener(scriptProgram ? "program" : "text-editor");
    setProgram(scriptProgram);
  }, [scriptProgram]);
  const save = (named: string) => {
    if (named.trim() !== scriptProgram) connection.send({ type: "settings.set-script-program", program: named.trim() });
  };
  const choose = (chosen: ScriptOpener) => {
    setOpener(chosen);
    if (chosen === "text-editor") save("");
  };
  return (
    <>
      <h3>File links</h3>
      <p className="hint">
        A file path in an agent's reply or tool card opens on the host's computer. A script opens as text, since the program for its type could run it.
        Kept by the host for every browser.
      </p>
      <div className="sending-settings">
        <label data-hint={hints.scriptProgram}>
          Scripts open in
          <select value={opener} onChange={(event) => choose(event.target.value as ScriptOpener)}>
            {Object.entries(scriptOpenerLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {opener === "program" && (
          <label>
            Program
            <input
              type="text"
              className="script-program"
              value={program}
              placeholder="Such as code or subl"
              spellCheck={false}
              onChange={(event) => setProgram(event.target.value)}
              onBlur={() => save(program)}
              onKeyDown={(event) => event.key === "Enter" && save(program)}
            />
          </label>
        )}
      </div>
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
