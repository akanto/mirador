import type { ConversationStatus, WaitingFor } from "../shared/model.ts";

export const hints = {
  yolo:
    "Approve everything without asking.\n\nWhen the agent asks for permission to run a tool, the host answers with the agent's own \"allow\" option at once instead of showing you a card. Switching it on also approves a request that is already waiting. Requests that offer no allow option still ask you.\n\nThis is separate from the agent's Mode: tools that the Mode already allows never ask at all. Saved per conversation.",
  profile:
    "The profile (environment variables and pre-launch command) the agent runs with.\n\nEach profile runs its own agent process. Switching closes this session on the current process and resumes it on the new one, so the agent keeps the whole conversation. The model goes back to the new profile's default.\n\nSwitching while the agent works stops its turn, moves the session, and asks the agent to continue where it left off; messages you queued go out after that.",
  questions:
    "What happens when the agent asks you something on the canvas.\n\nAgent waits: the agent's ask call stays open until you press Submit, and your answer comes back as its result, mid-turn.\n\nNext message: the ask call returns at once, the agent ends its turn, and your answer is sent later as your next message. Good for questions you want to think about.",
  configOption:
    "The agent offers this setting for the session. Changing it sends the new value to the agent (ACP session/set_config_option), which applies it to this conversation.",
  restartHost:
    "Starts the host again in place, so it runs its code as it is now. Agents that are working stop, then continue where they left off; queued messages are kept. Terminal shells start over. Open pages reload by themselves.",
  reviewLineNumber: "Click to select this line, Shift+click to select up to it. Then a asks the agent about the lines, o opens them in IntelliJ IDEA.",
  findingChecked: "Confirmed: the agent verified it (ran, traced or tested the code). Plausible: suspected, not verified.",
  findingDecision: "Kept findings go to the pull request when you post; dropped ones stay here. Click to switch.",
  promptTemplates: "Messages you send often, with the values you fill in each time. Settings adds, changes and deletes them.",
  deleteTemplateArmed: "Click again to delete this template. Defaults deleted here do not come back.",
  inviteDevice:
    "Makes a one-time code another browser or app joins this Mirador with, within 15 minutes. A joined device can do everything here, including run commands in terminals.",
  removeMachineArmed: "Click again to remove this machine from the list. It keeps running, and this browser stays joined to it.",
  machines: "Other computers running Mirador, such as a server whose agents keep working while this one sleeps.",
  revokeDeviceArmed: "Click again to sign this device out. It needs a new invite code to join again.",
  askAndUpdateReview:
    "Ask, and tell the agent to publish the review again if its answer changes a finding, the tour, the summary or the verdict. Your choices on the findings carry over.",
  answerDecision: "Kept answers go to their conversations on the pull request when you post, as replies on your pending review; dropped ones stay here. Click to switch.",
  answerResolve:
    "Resolve this conversation on GitHub when its answer is posted. The answer waits on your pending review until you submit it, but the conversation shows as resolved to everyone at once.",
  answerCannotResolve: "GitHub does not let you resolve this conversation.",
  findingOutsideDiff: "GitHub takes line comments only on changed lines and the 3 lines around them, so this one cannot be posted as a comment. It stays in the review.",
  fileInTour: "The flow tour passes through this file; such files come first.",
  revealUnderPrevious: "Shows the next lines of the file, under the change above.",
  revealOverNext: "Shows the lines of the file right above the change below.",
  revealAll: "Shows every line of the file between the two changes (or up to the file's start or end).",
  reviewPlacement: "Show the review over the whole workspace, or in the canvas pane next to the chat. Settings picks where reviews open.",
  reviewPlacementSetting: "Where a code review from the agent opens. Either way, the button in the review's bar switches between the two.",
  askPageBefore: "The agent showed this page just before asking, in the same turn. It stays above the question so you can read both; it is also in History on its own.",
  canvasToggle: "Hide or show the canvas pane. Drawings and questions still arrive while it's hidden and stay in History.",
  runCommand: "Runs the command after ! in this workspace's folder with your login shell, without input. Its output shows here and goes to the agent with your next message, as with ! in Claude Code. For interactive programs, use the terminal.",
  commandDelivery: "Commands you run with ! go to the agent with your next message, in the tags Claude Code uses for its own ! commands.",
  commandOutputsAttached: "These outputs of commands you ran with ! go ahead of your next message to the agent. ✕ keeps them out of it.",
  terminalToggle: "Hide or show a terminal in this workspace's folder. Its shell keeps running while the pane is hidden, and reloading the page reattaches to it.",
  terminalHide: "Hide the terminals. Their shells keep running; show them again from the conversation header or the command palette.",
  terminalNewTab: "Open a shell in a new tab, in this workspace's folder. Every window shows the same tabs.",
  terminalSplit: "Open another shell beside this one, in the same tab (up to 4).",
  terminalCloseTab: "Close this tab and end its shells.",
  terminalCloseTabArmed: "Click again to end the shells in this tab, and whatever they are running.",
  terminalCloseSplit: "End this shell and close its split.",
  terminalCloseSplitArmed: "Click again to end this shell and whatever it is running.",
  subagentsRunning:
    "Subagents the agent started that are still at work, also listed above the message box; click to open the first one. One started in the background counts until the turn that started it ends, since nothing tells when it finished before that.",
  runningSubagent: "A subagent at work. Click to open its card in the conversation and see what it has done so far.",
  inTerminal:
    "This Claude Code session is also running in a terminal. The host sees that in Claude Code's session registry (<config dir>/sessions/<pid>.json) and shows what the terminal is doing.",
  launch:
    "Agent (and profile) for new conversations in this workspace. Remembered per workspace. Existing conversations keep the agent they started with.",
  continueSession:
    "Pick up a Claude Code or opencode session that was started in a terminal in this directory. Continue it in place, or fork its history into a new conversation and leave the original alone.",
  profiles: "Named setups for an agent: environment variables and a pre-launch command, applied to the agent process the profile starts.",
  timestamps: "Off: the time shows next to each author's name, and on a later line while you point at it.\nOn: every line shows its time.",
  theme: "Light, dark, or follow the system setting.",
  waitingStyle:
    "How the sidebar marks a conversation whose agent waits for you: for an approval or an answer (Needs you), or because its turn ended while you looked elsewhere (Done, or Failed after an error).\n\nPill and count: a pill on the row and a count on its workspace. Dot only: a coloured dot and a bold title. Pills and a list on top: also lists every waiting conversation above the workspaces.",
  waitingCount: "Conversations in this workspace waiting for you.",
  workspaceColor: "Give this workspace a colour, to tell it apart in the sidebar. Every window shows it.",
  workspaceColorStyle:
    "How a workspace you gave a colour shows it: on its whole card, on its heading only, or as a stripe down its edge over a softer tint. Click a workspace's initials to give it a colour.",
  newConversation: "Start a conversation in this workspace, with the agent picked next to this button.",
  addWorkspace: "Add a project directory. Its conversations run with it as the working directory.",
  removeWorkspace: "Remove this workspace and its conversations from the app. The directory and its files are not touched.",
  removeWorkspaceArmed: "Click again to remove this workspace and its conversations from the app. The directory and its files are not touched.",
  deleteConversation: "Delete this conversation, its timeline and its canvas history from the app. The agent's own session files stay on disk.",
  deleteConversationArmed: "Click again to delete this conversation. The agent's own session files stay on disk.",
  deleteProfileArmed: "Click again to delete this profile. Its conversations can continue with another profile.",
  splitter: "Drag to resize, double-click to reset.",
  composerGrip: "Drag up to make the message box taller, down to make it smaller; it still grows with longer text. Every conversation in this browser uses the same height. Double-click to let it fit the text again.",
  paneGrip: "Drag onto another pane to swap the two. Each conversation remembers its own layout; Settings picks the one new conversations start with.",
  paneFullscreen: "Fill the workspace with this pane. Double-clicking the bar does the same.",
  paneExitFullscreen: "Back to the other panes. Esc does the same, except in a terminal, which keeps Esc for itself.",
  canvasHide: "Hide the canvas. Drawings and questions still arrive and stay in History; show it again from the conversation header or the palette.",
  settings: "The theme, timestamps, the layout new conversations start with, system notifications, and on macOS whether it corrects your spelling or predicts words as you type.",
  queue:
    "Messages you send while the agent works wait here.\n\nWith Claude Code, a message tagged \"joins the turn\" goes into the running turn as soon as the tools the agent is running finish, as in its own terminal, so the agent reads it before its next step. One tagged \"after the turn\" waits until the turn ends, then goes out as your next message. Enter and ⌥Enter (Alt+Enter) send one way each; Settings picks which. opencode can't take messages into a running turn, so with it they all wait.\n\nMessages that wait go out one at a time, each when the turn before it ends, also after you press Stop. Drag a message by its ⋮⋮ to change the order they go out in. Edit moves a message back into the message box; ↑ in an empty box does the same for the last one. The queue is kept by the host, so it survives a page reload and a host restart.",
  usageLimit:
    "Claude Code stopped at its usage limit. Instead of sending your queued messages into the same wall, the host keeps them, and like Claude Code it asks the agent to continue where it left off a minute after the limit resets; your queued messages follow. It does that at most twice in a row by itself; after that, or when the message names no reset time, it waits for you.\n\nThe wait survives a host restart.",
  continueAfterUsageLimit: "Ask the agent to continue where it left off now, e.g. after switching to a profile that signs in to another account. Queued messages follow.",
  stopWaitingForUsageLimit: "Stop waiting for the reset: the agent does not continue by itself, and messages you queued go out now.",
  canvasUse:
    "As needed: the agent decides from the canvas's own instructions.\n\nOften: Claude Code's system prompt also tells it to put explanations, comparisons, plans and the summary of a larger piece of work on the canvas, and to ask you choices there.\n\nPages cost more tokens than the same answer as text.",
  logIn:
    "Opens the agent's own sign-in in a terminal tab of this workspace, with this conversation's profile, so a profile with an account of its own signs that one in. Once it says you are signed in, send your message again.",
  queuedGrip: "Drag to change the order queued messages go out in: they leave from the top.",
  queuedDelivery: "How this message goes out: into the running turn once the agent's tools finish, or after the turn ends. Click to switch.",
  steerMessage: "Adds the message to the running turn: Claude Code reads it as soon as the tools it is running finish, before its next step.",
  afterTurnMessage: "Keeps the message until the running turn ends (or you press Stop), then sends it as your next message.",
  enterWhileBusy: "What Enter does with a message while the agent works; ⌥Enter (Alt+Enter) does the other. With opencode, messages always wait for the turn to end.",
  scriptMessage:
    "A script the agent started sent this as your next message, so the agent picks up when the script is done. Scripts send with scripts/mirador-message.",
  gitBranch: "The git branch checked out in the workspace directory.",
  model: "The model the agent uses, as chosen in the Model menu above.",
  cost: "What the conversation has cost so far, as the agent reports it.",
  profileChip: "The profile this conversation's agent runs with.",
  statuslineCommand: (command: string) =>
    `Your statusline, printed by ${command}.\n\nThe host runs it like Claude Code does: Claude Code's statusline JSON on stdin (model, cwd, session, transcript, context window, cost) and the conversation's profile environment. Switch to the built-in statusline here.`,
  statuslineBuiltIn: (command: string) =>
    `The built-in statusline.\n\nClaude Code's settings name a statusline command (${command}); switch to it here.`,
  canvasOlder: "Show the previous canvas item.",
  canvasNewer: "Show the next canvas item.",
  canvasHistory: "Everything the agent drew or asked in this conversation, newest first.",
  canvasClear: "Empty the canvas. Nothing is deleted: the item stays in History.",
} as const;

export const waitingHints: Record<WaitingFor, string> = {
  permission: "Needs you: the agent waits for you to approve a tool.",
  question: "Needs you: the agent asked you a question on the canvas.",
  finished: "Done: the turn ended while you were looking elsewhere. Opening the conversation clears this.",
  error: "Failed: the turn stopped with an error while you were looking elsewhere. Opening the conversation clears this.",
};

export const statusHints: Record<ConversationStatus, string> = {
  idle: "Idle: waiting for your next message.",
  starting: "Starting: the host is launching the agent process or resuming the session on it.",
  running: "Running: the agent is working on your message. Esc or Stop cancels the turn.",
  error: "Error: the agent could not start or resume. The details are under the header.",
};
