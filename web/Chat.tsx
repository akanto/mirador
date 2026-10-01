import type { SessionConfigOption, ToolCallContent } from "@agentclientprotocol/sdk";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { flatSelectOptions } from "../shared/config-options.ts";
import {
  harnessLabels,
  terminalActivityLabels,
  type AskMode,
  type Conversation,
  type HarnessId,
  type Profile,
  type QueuedMessage,
} from "../shared/model.ts";
import { awaitingDelivery, outputOf, type UserCommand } from "../shared/user-commands.ts";
import { parseAnsi, plainTextOf } from "./ansi.ts";
import { connection } from "./connection.ts";
import { choiceGroups } from "./choices.ts";
import { ConversationTitle } from "./ConversationTitle.tsx";
import { lineDiff } from "./diff.ts";
import { joinDrafts, useDraft } from "./drafts.ts";
import { hints, statusHints } from "./hints.ts";
import { SearchableSelect } from "./SearchableSelect.tsx";
import { commandLineOf, isShellCommand, shellCommandOf } from "./shell.ts";
import { Statusline } from "./Statusline.tsx";
import type { OpenConversation } from "./state.ts";
import { authorOf, buildTimeline, contentText, startsAuthorGroup, type Author, type PermissionBlock, type TimelineBlock, type ToolBlock } from "./timeline.ts";
import { formatClockTime, formatFullTime } from "./timestamps.ts";

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Past this many choices a plain select is hard to scan: opencode lists every model of every provider. */
const SEARCHABLE_FROM_CHOICES = 20;

const configOptionHint = (option: SessionConfigOption) => [option.description, hints.configOption].filter(Boolean).join("\n\n");

function ConfigControl({ conversationId, option }: { conversationId: string; option: SessionConfigOption }) {
  const setValue = (value: string | boolean) => connection.send({ type: "conversation.set-config", conversationId, configId: option.id, value });
  if (option.type === "boolean") {
    return (
      <label className="config" data-hint={configOptionHint(option)}>
        <input type="checkbox" aria-label={option.name} checked={option.currentValue} onChange={(event) => setValue(event.target.checked)} />
        {option.name}
      </label>
    );
  }
  const choices = flatSelectOptions(option);
  if (choices.length > SEARCHABLE_FROM_CHOICES) {
    return (
      <SearchableSelect
        label={option.name}
        hint={configOptionHint(option)}
        value={option.currentValue}
        groups={choiceGroups(option)}
        onChange={setValue}
      />
    );
  }
  return (
    <label className="config" data-hint={configOptionHint(option)}>
      <span>{option.name}</span>
      <select aria-label={option.name} value={option.currentValue} onChange={(event) => setValue(event.target.value)}>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value} title={choice.description ?? undefined}>
            {choice.name}
          </option>
        ))}
      </select>
    </label>
  );
}

const isBusy = (conversation: Conversation) => conversation.status === "running" || conversation.status === "starting";

/** Only profiles of the conversation's own agent: another agent cannot continue its session. */
function ProfilePicker({ conversation, profiles }: { conversation: Conversation; profiles: Profile[] }) {
  const choices = profiles.filter(({ harness }) => harness === conversation.harness);
  const profileWasDeleted = conversation.profileId !== null && !choices.some(({ id }) => id === conversation.profileId);
  return (
    <label className="config" data-hint={hints.profile}>
      <span>Profile</span>
      <select
        aria-label="Profile"
        value={conversation.profileId ?? ""}
        disabled={isBusy(conversation)}
        onChange={(event) =>
          connection.send({ type: "conversation.set-profile", conversationId: conversation.id, profileId: event.target.value || null })
        }
      >
        <option value="">None</option>
        {choices.map(({ id, name }) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
        {profileWasDeleted && (
          <option value={conversation.profileId!} disabled>
            Deleted profile
          </option>
        )}
      </select>
    </label>
  );
}

function YoloSwitch({ conversation }: { conversation: Conversation }) {
  return (
    <label
      className={`config yolo ${conversation.bypassPermissions ? "on" : ""}`}
      data-hint={hints.yolo}
    >
      <input
        type="checkbox"
        aria-label="YOLO"
        checked={conversation.bypassPermissions}
        onChange={(event) =>
          connection.send({ type: "conversation.set-bypass-permissions", conversationId: conversation.id, bypassPermissions: event.target.checked })
        }
      />
      YOLO
    </label>
  );
}

const askModeLabels: Record<AskMode, string> = {
  wait: "Agent waits for my answer",
  "next-message": "My answer is sent as the next message",
};

function ChatHeader({
  conversation,
  profiles,
  canvasVisible,
  onToggleCanvas,
  terminalVisible,
  onToggleTerminal,
}: {
  conversation: Conversation;
  profiles: Profile[];
  canvasVisible: boolean;
  onToggleCanvas: () => void;
  terminalVisible: boolean;
  onToggleTerminal: () => void;
}) {
  return (
    <header className="chat-header">
      <div className="title-row">
        <h2>
          <ConversationTitle conversation={conversation} startEditingOn="click" className="conversation-name" />
        </h2>
        <span className={`badge status-${conversation.status}`} data-hint={statusHints[conversation.status]}>
          {conversation.status}
        </span>
        {conversation.openInTerminal && (
          <span className={`badge terminal-${conversation.openInTerminal}`} data-hint={hints.inTerminal}>
            in a terminal · {terminalActivityLabels[conversation.openInTerminal]}
          </span>
        )}
        <span className="harness">{harnessLabels[conversation.harness]}</span>
        <button className="toggle-canvas" data-hint={hints.canvasToggle} onClick={onToggleCanvas}>
          {canvasVisible ? "Hide canvas" : "Show canvas"}
        </button>
        <button className="toggle-terminal" data-hint={hints.terminalToggle} onClick={onToggleTerminal}>
          {terminalVisible ? "Hide terminal" : "Show terminal"}
        </button>
      </div>
      {conversation.statusDetail && <div className="status-detail">{conversation.statusDetail}</div>}
      <div className="controls">
        <ProfilePicker conversation={conversation} profiles={profiles} />
        {conversation.configOptions.map((option) => (
          <ConfigControl key={option.id} conversationId={conversation.id} option={option} />
        ))}
        <YoloSwitch conversation={conversation} />
        <label className="config" data-hint={hints.questions}>
          <span>Questions</span>
          <select
            aria-label="Questions"
            value={conversation.askMode}
            onChange={(event) =>
              connection.send({ type: "conversation.set-ask-mode", conversationId: conversation.id, askMode: event.target.value as AskMode })
            }
          >
            {(Object.keys(askModeLabels) as AskMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {askModeLabels[mode]}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}

function DiffView({ path, oldText, newText }: { path: string; oldText?: string | null; newText: string }) {
  const lines = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  return (
    <div className="diff">
      <div className="diff-path">{path}</div>
      <pre>
        {lines.map((line, index) => (
          <div key={index} className={`diff-${line.kind}`}>
            {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

function ToolContent({ content }: { content: ToolCallContent }) {
  switch (content.type) {
    case "content":
      return <pre className="tool-output">{contentText(content.content)}</pre>;
    case "diff":
      return <DiffView path={content.path} oldText={content.oldText} newText={content.newText} />;
    case "terminal":
      return <pre className="tool-output">(terminal {content.terminalId})</pre>;
  }
}

function RawJson({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <details className="raw">
      <summary>{label}</summary>
      <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function readableToolTitle(title: string) {
  const mcpTool = title.match(/^mcp__(.+?)__(.+)$/);
  return mcpTool ? `${mcpTool[1]} · ${mcpTool[2]}` : title;
}

const statusIcons: Record<string, string> = { pending: "○", in_progress: "◐", completed: "●", failed: "✕" };

const PREVIEW_LINES = 8;

const ToolCallsAwaitingPermission = createContext<ReadonlySet<string>>(new Set());

const toolCallsAwaitingPermission = (timeline: TimelineBlock[]) =>
  new Set(timeline.flatMap((block) => (block.kind === "permission" && !block.resolved ? [block.toolCall.toolCallId] : [])));

const lastPathSegment = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

function CommandLine({ command, directory }: { command: string; directory?: string | null }) {
  return (
    <div className="shell-command">
      <span className="shell-prompt" data-hint={directory ?? undefined}>
        {directory ? `${lastPathSegment(directory)} $` : "$"}
      </span>
      <span className="shell-typed">{command}</span>
    </div>
  );
}

function TerminalOutput({ output, finished, awaitingPermission }: { output: string; finished: boolean; awaitingPermission: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const lines = output ? output.split("\n") : [];
  const hiddenCount = expanded ? 0 : Math.max(0, lines.length - PREVIEW_LINES);
  if (lines.length === 0) {
    const quiet = finished ? "(no output)" : awaitingPermission ? "waiting for your approval…" : "running…";
    return <div className="shell-quiet">{quiet}</div>;
  }
  return (
    <>
      <pre className="shell-output">{lines.slice(0, lines.length - hiddenCount).join("\n")}</pre>
      {hiddenCount > 0 && (
        <button type="button" className="shell-more" onClick={() => setExpanded(true)}>
          Show {hiddenCount} more {hiddenCount === 1 ? "line" : "lines"}
        </button>
      )}
      {expanded && lines.length > PREVIEW_LINES && (
        <button type="button" className="shell-more" onClick={() => setExpanded(false)}>
          Show less
        </button>
      )}
    </>
  );
}

function ShellCard({ block }: { block: ToolBlock }) {
  const { command, description, output, exitCode, directory } = shellCommandOf(block);
  const status = block.status ?? "pending";
  const failed = status === "failed" || (exitCode !== null && exitCode !== 0);
  const finished = status === "completed" || status === "failed";
  const awaitingPermission = useContext(ToolCallsAwaitingPermission).has(block.toolCallId);
  return (
    <div className={`shell tool-${status}`}>
      <div className="shell-header">
        <span className="tool-status">{statusIcons[status]}</span>
        <span className="shell-description">{description ?? "Shell command"}</span>
        {failed && <span className="shell-exit">{exitCode !== null ? `exit ${exitCode}` : "failed"}</span>}
      </div>
      <div className="shell-body">
        <CommandLine command={command} directory={directory} />
        {(status !== "pending" || awaitingPermission) && <TerminalOutput output={output} finished={finished} awaitingPermission={awaitingPermission} />}
      </div>
    </div>
  );
}

function commandDelivery({ delivery, ended }: UserCommand) {
  if (delivery === "sent") return "Sent to the agent with your message";
  if (delivery === "dropped") return "Not sent to the agent";
  return ended ? "Goes to the agent with your next message" : "Goes to the agent with your next message once it finishes";
}

/** A command the user ran with `!` in the message box. */
function CommandCard({ command, conversationId }: { command: UserCommand; conversationId: string }) {
  const status = !command.ended ? "in_progress" : command.exitCode === 0 ? "completed" : "failed";
  const output = useMemo(() => plainTextOf(parseAnsi(outputOf(command))).trimEnd(), [command]);
  const stop = () => connection.send({ type: "conversation.stop-command", conversationId, commandId: command.commandId });
  return (
    <div className={`shell user-command tool-${status}`}>
      <div className="shell-header">
        <span className="tool-status">{statusIcons[status]}</span>
        <span className="shell-description" data-hint={hints.commandDelivery}>
          {commandDelivery(command)}
        </span>
        {status === "failed" && <span className="shell-exit">{command.exitCode === null ? "stopped" : `exit ${command.exitCode}`}</span>}
        {!command.ended && (
          <button type="button" className="link stop-command" onClick={stop}>
            Stop
          </button>
        )}
      </div>
      <div className="shell-body">
        <CommandLine command={command.command} />
        <TerminalOutput output={output} finished={command.ended} awaitingPermission={false} />
      </div>
    </div>
  );
}

function ToolCard({ block }: { block: ToolBlock }) {
  if (isShellCommand(block)) return <ShellCard block={block} />;
  return (
    <details className={`tool tool-${block.status ?? "pending"}`}>
      <summary>
        <span className="tool-status">{statusIcons[block.status ?? "pending"]}</span>
        <span className="tool-title">{readableToolTitle(block.title)}</span>
        {block.toolKind && <span className="tool-kind">{block.toolKind}</span>}
      </summary>
      {block.locations.length > 0 && (
        <div className="locations">{block.locations.map((location) => `${location.path}${location.line ? `:${location.line}` : ""}`).join(", ")}</div>
      )}
      {block.content.map((content, index) => (
        <ToolContent key={index} content={content} />
      ))}
      <RawJson label="input" value={block.rawInput} />
      <RawJson label="output" value={block.rawOutput} />
    </details>
  );
}

function permissionSubject(toolCall: PermissionBlock["toolCall"]) {
  if (toolCall.kind !== "execute") return toolCall.title ?? "tool call";
  const description = (toolCall.rawInput as { description?: unknown } | null | undefined)?.description;
  return typeof description === "string" ? description : "run a shell command";
}

function PermissionCard({ block, conversationId }: { block: PermissionBlock; conversationId: string }) {
  const respond = (optionId: string | null) =>
    connection.send({ type: "permission.respond", conversationId, permissionId: block.permissionId, optionId });
  const chosen = block.options.find(({ optionId }) => optionId === block.chosenOptionId);
  return (
    <div className={`permission ${block.resolved ? "resolved" : "pending"}`}>
      <div className="permission-title">
        {block.resolved ? "Permission" : "Permission needed"}: {permissionSubject(block.toolCall)}
      </div>
      {block.toolCall.kind === "execute" ? (
        <div className="shell-body">
          <CommandLine command={commandLineOf(block.toolCall.rawInput, block.toolCall.title ?? "")} />
        </div>
      ) : (
        <>
          {block.toolCall.content?.map((content, index) => <ToolContent key={index} content={content} />)}
          <RawJson label="input" value={block.toolCall.rawInput} />
        </>
      )}
      {block.resolved ? (
        <div className="permission-outcome">{chosen ? chosen.name : "Cancelled"}</div>
      ) : (
        <div className="permission-options">
          {block.options.map((option) => (
            <button key={option.optionId} className={`option-${option.kind}`} onClick={() => respond(option.optionId)}>
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const agentNames: Record<HarnessId, string> = { claude: "Claude", opencode: "opencode" };
const agentMarks: Record<HarnessId, string> = { claude: "✳", opencode: "◆" };

function PersonIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="5.2" r="3" fill="currentColor" />
      <path d="M2.4 14.6c.7-3.1 2.9-4.6 5.6-4.6s4.9 1.5 5.6 4.6z" fill="currentColor" />
    </svg>
  );
}

function Avatar({ author, harness }: { author: Author; harness: HarnessId }) {
  return author === "user" ? (
    <span className="avatar user" aria-hidden="true">
      <PersonIcon />
    </span>
  ) : (
    <span className={`avatar agent-${harness}`} aria-hidden="true">
      {agentMarks[harness]}
    </span>
  );
}

function Timestamp({ at }: { at: number }) {
  return (
    <time className="timestamp" dateTime={new Date(at).toISOString()} title={formatFullTime(at)}>
      {formatClockTime(at)}
    </time>
  );
}

function TimestampedEntry({
  block,
  startsGroup,
  harness,
  conversationId,
}: {
  block: TimelineBlock;
  startsGroup: boolean;
  harness: HarnessId;
  conversationId: string;
}) {
  const author = authorOf(block);
  return (
    <div className={`timeline-entry ${startsGroup ? "group-start" : ""} ${author ? "" : "notice-entry"}`}>
      <div className="gutter">{startsGroup && author ? <Avatar author={author} harness={harness} /> : <Timestamp at={block.at} />}</div>
      <div className="entry-body">
        {startsGroup && (
          <div className="author">
            {author === "user" ? "You" : agentNames[harness]}
            <Timestamp at={block.at} />
          </div>
        )}
        <TimelineEntry block={block} conversationId={conversationId} />
      </div>
    </div>
  );
}

function TimelineEntry({ block, conversationId }: { block: TimelineBlock; conversationId: string }) {
  switch (block.kind) {
    case "user":
      return <div className="message user">{block.text}</div>;
    case "agent":
      return (
        <div className="message agent">
          <MarkdownText text={block.text} />
        </div>
      );
    case "thought":
      return (
        <details className="thought">
          <summary>Thinking</summary>
          <MarkdownText text={block.text} />
        </details>
      );
    case "tool":
      return <ToolCard block={block} />;
    case "command":
      return <CommandCard command={block.command} conversationId={conversationId} />;
    case "plan":
      return (
        <div className="plan">
          <div className="plan-title">Plan</div>
          <ul>
            {block.entries.map((entry, index) => (
              <li key={index} className={`plan-${entry.status}`}>
                {statusIcons[entry.status]} {entry.content}
              </li>
            ))}
          </ul>
        </div>
      );
    case "permission":
      return <PermissionCard block={block} conversationId={conversationId} />;
    case "notice":
      return <div className="notice-line">{block.text}</div>;
    case "info":
      return (
        <div className="info-line">
          <MarkdownText text={block.text} />
        </div>
      );
    case "error":
      return <div className="error-line">{block.message}</div>;
  }
}

function useStickToBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);
  const onScroll = () => {
    const element = ref.current;
    if (element) pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };
  return { ref, onScroll };
}

function QueuedMessages({ messages, onEdit, onRemove }: { messages: QueuedMessage[]; onEdit: (message: QueuedMessage) => void; onRemove: (message: QueuedMessage) => void }) {
  return (
    <section className="queue" aria-label="Queued messages">
      <header data-hint={hints.queue}>Queued · sent when the agent finishes its turn</header>
      <ol>
        {messages.map((message) => (
          <li key={message.id} className="queued">
            <span className="queued-text">{message.text}</span>
            <button type="button" className="link" onClick={() => onEdit(message)}>
              Edit
            </button>
            <button type="button" className="link" onClick={() => onRemove(message)}>
              Remove
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** `!git status` in the message box runs `git status` instead of messaging the agent. */
const commandIn = (text: string) => (text.trimStart().startsWith("!") ? text.trimStart().slice(1).trim() : null);

function CommandOutputsAttached({ commands, conversationId }: { commands: UserCommand[]; conversationId: string }) {
  if (commands.length === 0) return null;
  const drop = () => connection.send({ type: "conversation.drop-command-outputs", conversationId, commandIds: commands.map(({ commandId }) => commandId) });
  return (
    <div className="command-outputs-attached" data-hint={hints.commandOutputsAttached}>
      <span>{commands.length === 1 ? "1 command output goes" : `${commands.length} command outputs go`} with your next message</span>
      <button type="button" className="icon" aria-label="Don't send the command outputs" onClick={drop}>
        ✕
      </button>
    </div>
  );
}

function Composer({ conversation, pendingCommands }: { conversation: Conversation; pendingCommands: UserCommand[] }) {
  const [text, setText] = useDraft(conversation.id);
  const busy = isBusy(conversation);
  const queued = conversation.queuedMessages;
  const command = commandIn(text);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => textarea.current?.focus(), []);

  const send = () => {
    if (!text.trim() || command === "") return;
    const message =
      command === null
        ? ({ type: "conversation.prompt", conversationId: conversation.id, text } as const)
        : ({ type: "conversation.run-command", conversationId: conversation.id, command } as const);
    if (connection.send(message)) setText("");
  };
  const cancel = () => connection.send({ type: "conversation.cancel", conversationId: conversation.id });
  const remove = (message: QueuedMessage) =>
    connection.send({ type: "conversation.queue.remove", conversationId: conversation.id, messageId: message.id });
  const pullBack = (message: QueuedMessage) => {
    remove(message);
    setText((current) => joinDrafts(current, message.text));
    textarea.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const lastQueued = queued.at(-1);
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "ArrowUp" && !text && lastQueued) {
      event.preventDefault();
      pullBack(lastQueued);
    } else if (event.key === "Escape" && busy) {
      cancel();
    }
  };

  return (
    <div className="composer-area">
      {queued.length > 0 && <QueuedMessages messages={queued} onEdit={pullBack} onRemove={remove} />}
      <CommandOutputsAttached commands={pendingCommands} conversationId={conversation.id} />
      <div className={command === null ? "composer" : "composer shell-mode"}>
        <textarea
          ref={textarea}
          value={text}
          rows={Math.min(10, Math.max(2, text.split("\n").length))}
          placeholder={
            busy
              ? "The agent is working… Enter queues your message, Esc stops the agent"
              : `Message ${harnessLabels[conversation.harness]} (Enter to send, Shift+Enter for a new line, ! to run a command)`
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {command !== null ? (
          <button className="run-command" data-hint={hints.runCommand} onClick={send} disabled={!command}>
            Run
          </button>
        ) : (
          busy &&
          text.trim() && (
            <button className="queue-message" onClick={send}>
              Queue
            </button>
          )
        )}
        {busy ? (
          <button className="stop" onClick={cancel}>
            Stop
          </button>
        ) : (
          command === null && (
            <button className="send" onClick={send} disabled={!text.trim()}>
              Send
            </button>
          )
        )}
      </div>
    </div>
  );
}

export function ChatPanel({
  conversation,
  profiles,
  open,
  canvasVisible,
  onToggleCanvas,
  terminalVisible,
  onToggleTerminal,
}: {
  conversation: Conversation;
  profiles: Profile[];
  open: OpenConversation;
  canvasVisible: boolean;
  onToggleCanvas: () => void;
  terminalVisible: boolean;
  onToggleTerminal: () => void;
}) {
  const timeline = useMemo(() => buildTimeline(open.events), [open.events]);
  const pendingCommands = useMemo(() => awaitingDelivery(timeline.flatMap((block) => (block.kind === "command" ? [block.command] : []))), [timeline]);
  const awaitingPermission = useMemo(() => toolCallsAwaitingPermission(timeline), [timeline]);
  const { ref, onScroll } = useStickToBottom(open.events.length);
  return (
    <ToolCallsAwaitingPermission.Provider value={awaitingPermission}>
      <ChatHeader
        conversation={conversation}
        profiles={profiles}
        canvasVisible={canvasVisible}
        onToggleCanvas={onToggleCanvas}
        terminalVisible={terminalVisible}
        onToggleTerminal={onToggleTerminal}
      />
      <div className="timeline" ref={ref} onScroll={onScroll}>
        {!open.loaded && <div className="notice-line">Loading…</div>}
        {open.loaded && timeline.length === 0 && <div className="notice-line">{harnessLabels[conversation.harness]} runs in this workspace's directory. Ask it anything; it can draw in the canvas on the right.</div>}
        {timeline.map((block, index) => (
          <TimestampedEntry
            key={block.key}
            block={block}
            startsGroup={startsAuthorGroup(timeline, index)}
            harness={conversation.harness}
            conversationId={conversation.id}
          />
        ))}
        {conversation.status === "running" && <div className="working">Working…</div>}
      </div>
      {conversation.openInTerminal && (
        <div className="terminal-warning" role="status">
          This session is also open in Claude Code in a terminal ({terminalActivityLabels[conversation.openInTerminal]} there). What happens
          there doesn't show up here, and a message sent from here splits the session's history: continue in the terminal, or quit
          it there first.
        </div>
      )}
      <Composer conversation={conversation} pendingCommands={pendingCommands} />
      <Statusline conversation={conversation} profiles={profiles} />
    </ToolCallsAwaitingPermission.Provider>
  );
}
