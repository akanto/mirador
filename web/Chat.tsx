import type { SessionConfigOption, SessionConfigSelectOption, ToolCallContent } from "@agentclientprotocol/sdk";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { harnessLabels, terminalActivityLabels, type AskMode, type Conversation, type Profile } from "../shared/model.ts";
import { connection } from "./connection.ts";
import { ConversationTitle } from "./ConversationTitle.tsx";
import { lineDiff } from "./diff.ts";
import type { OpenConversation } from "./state.ts";
import { buildTimeline, contentText, type PermissionBlock, type TimelineBlock, type ToolBlock } from "./timeline.ts";
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

function flatSelectOptions(option: Extract<SessionConfigOption, { type: "select" }>): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]));
}

function ConfigControl({ conversationId, option }: { conversationId: string; option: SessionConfigOption }) {
  const setValue = (value: string | boolean) => connection.send({ type: "conversation.set-config", conversationId, configId: option.id, value });
  if (option.type === "boolean") {
    return (
      <label className="config" title={option.description ?? undefined}>
        <input type="checkbox" aria-label={option.name} checked={option.currentValue} onChange={(event) => setValue(event.target.checked)} />
        {option.name}
      </label>
    );
  }
  return (
    <label className="config" title={option.description ?? undefined}>
      <span>{option.name}</span>
      <select aria-label={option.name} value={option.currentValue} onChange={(event) => setValue(event.target.value)}>
        {flatSelectOptions(option).map((choice) => (
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
    <label className="config" title="Profile the agent runs with; the conversation continues where it left off">
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

const askModeLabels: Record<AskMode, string> = {
  wait: "Agent waits for my answer",
  "next-message": "My answer is sent as the next message",
};

function ChatHeader({
  conversation,
  profiles,
  canvasVisible,
  onToggleCanvas,
}: {
  conversation: Conversation;
  profiles: Profile[];
  canvasVisible: boolean;
  onToggleCanvas: () => void;
}) {
  return (
    <header className="chat-header">
      <div className="title-row">
        <h2>
          <ConversationTitle conversation={conversation} startEditingOn="click" className="conversation-name" />
        </h2>
        <span className={`badge status-${conversation.status}`}>{conversation.status}</span>
        {conversation.openInTerminal && (
          <span className={`badge terminal-${conversation.openInTerminal}`} title="This session is also open in Claude Code in a terminal">
            in a terminal · {terminalActivityLabels[conversation.openInTerminal]}
          </span>
        )}
        <span className="harness">{harnessLabels[conversation.harness]}</span>
        <button className="toggle-canvas" onClick={onToggleCanvas}>
          {canvasVisible ? "Hide canvas" : "Show canvas"}
        </button>
      </div>
      {conversation.statusDetail && <div className="status-detail">{conversation.statusDetail}</div>}
      <div className="controls">
        <ProfilePicker conversation={conversation} profiles={profiles} />
        {conversation.configOptions.map((option) => (
          <ConfigControl key={option.id} conversationId={conversation.id} option={option} />
        ))}
        <label className="config" title="What happens when the agent asks you a question in the canvas">
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

function ToolCard({ block }: { block: ToolBlock }) {
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

function PermissionCard({ block, conversationId }: { block: PermissionBlock; conversationId: string }) {
  const respond = (optionId: string | null) =>
    connection.send({ type: "permission.respond", conversationId, permissionId: block.permissionId, optionId });
  const chosen = block.options.find(({ optionId }) => optionId === block.chosenOptionId);
  return (
    <div className={`permission ${block.resolved ? "resolved" : "pending"}`}>
      <div className="permission-title">
        {block.resolved ? "Permission" : "Permission needed"}: {block.toolCall.title ?? "tool call"}
      </div>
      {block.toolCall.content?.map((content, index) => <ToolContent key={index} content={content} />)}
      <RawJson label="input" value={block.toolCall.rawInput} />
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

function TimestampedEntry({ block, conversationId }: { block: TimelineBlock; conversationId: string }) {
  return (
    <div className="timeline-entry">
      <time className="timestamp" dateTime={new Date(block.at).toISOString()} title={formatFullTime(block.at)}>
        {formatClockTime(block.at)}
      </time>
      <div className="entry-body">
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

function Composer({ conversation }: { conversation: Conversation }) {
  const [text, setText] = useState("");
  const busy = isBusy(conversation);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => textarea.current?.focus(), []);

  const send = () => {
    if (!text.trim() || busy) return;
    if (connection.send({ type: "conversation.prompt", conversationId: conversation.id, text })) setText("");
  };
  const cancel = () => connection.send({ type: "conversation.cancel", conversationId: conversation.id });
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape" && busy) {
      cancel();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={textarea}
        value={text}
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        placeholder={
          busy ? "The agent is working… (Esc to stop)" : `Message ${harnessLabels[conversation.harness]} (Enter to send, Shift+Enter for a new line)`
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <button className="stop" onClick={cancel}>
          Stop
        </button>
      ) : (
        <button className="send" onClick={send} disabled={!text.trim()}>
          Send
        </button>
      )}
    </div>
  );
}

export function ChatPanel({
  conversation,
  profiles,
  open,
  canvasVisible,
  onToggleCanvas,
}: {
  conversation: Conversation;
  profiles: Profile[];
  open: OpenConversation;
  canvasVisible: boolean;
  onToggleCanvas: () => void;
}) {
  const timeline = useMemo(() => buildTimeline(open.events), [open.events]);
  const { ref, onScroll } = useStickToBottom(open.events.length);
  return (
    <>
      <ChatHeader conversation={conversation} profiles={profiles} canvasVisible={canvasVisible} onToggleCanvas={onToggleCanvas} />
      <div className="timeline" ref={ref} onScroll={onScroll}>
        {!open.loaded && <div className="notice-line">Loading…</div>}
        {open.loaded && timeline.length === 0 && <div className="notice-line">{harnessLabels[conversation.harness]} runs in this workspace's directory. Ask it anything; it can draw in the canvas on the right.</div>}
        {timeline.map((block) => (
          <TimestampedEntry key={block.key} block={block} conversationId={conversation.id} />
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
      <Composer conversation={conversation} />
    </>
  );
}
