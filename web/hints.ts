import type { ConversationStatus } from "../shared/model.ts";

export const hints = {
  yolo:
    "Approve everything without asking.\n\nWhen the agent asks for permission to run a tool, the host answers with the agent's own \"allow\" option at once instead of showing you a card. Switching it on also approves a request that is already waiting. Requests that offer no allow option still ask you.\n\nThis is separate from the agent's Mode: tools that the Mode already allows never ask at all. Saved per conversation.",
  profile:
    "The profile (environment variables and pre-launch command) the agent runs with.\n\nEach profile runs its own agent process. Switching closes this session on the current process and resumes it on the new one, so the agent keeps the whole conversation. The model goes back to the new profile's default. Locked while the agent is working.",
  questions:
    "What happens when the agent asks you something on the canvas.\n\nAgent waits: the agent's ask call stays open until you press Submit, and your answer comes back as its result, mid-turn.\n\nNext message: the ask call returns at once, the agent ends its turn, and your answer is sent later as your next message. Good for questions you want to think about.",
  configOption:
    "The agent offers this setting for the session. Changing it sends the new value to the agent (ACP session/set_config_option), which applies it to this conversation.",
  canvasToggle: "Hide or show the canvas pane. Drawings and questions still arrive while it's hidden and stay in History.",
  runCommand: "Runs the command after ! in this workspace's folder with your login shell, without input. Its output shows here and goes to the agent with your next message, as with ! in Claude Code. For interactive programs, use the terminal.",
  commandDelivery: "Commands you run with ! go to the agent with your next message, in the tags Claude Code uses for its own ! commands.",
  commandOutputsAttached: "These outputs of commands you ran with ! go ahead of your next message to the agent. ✕ keeps them out of it.",
  terminalToggle: "Hide or show a terminal in this workspace's folder. Its shell keeps running while the pane is hidden, and reloading the page reattaches to it.",
  terminalHide: "Hide the terminal. The shell keeps running; show it again from the conversation header or the command palette.",
  inTerminal:
    "This Claude Code session is also running in a terminal. The host sees that in Claude Code's session registry (<config dir>/sessions/<pid>.json) and shows what the terminal is doing.",
  launch:
    "Agent (and profile) for new conversations in this workspace. Remembered per workspace. Existing conversations keep the agent they started with.",
  continueSession:
    "Pick up a Claude Code or opencode session that was started in a terminal in this directory. Continue it in place, or fork its history into a new conversation and leave the original alone.",
  profiles: "Named setups for an agent: environment variables and a pre-launch command, applied to the agent process the profile starts.",
  timestamps: "Off: the time shows next to each author's name, and on a later line while you point at it.\nOn: every line shows its time.",
  theme: "Light, dark, or follow the system setting. The sidebar stays dark either way.",
  addWorkspace: "Add a project directory. Its conversations run with it as the working directory.",
  removeWorkspace: "Remove this workspace and its conversations from the app. The directory and its files are not touched.",
  removeWorkspaceArmed: "Click again to remove this workspace and its conversations from the app. The directory and its files are not touched.",
  deleteConversation: "Delete this conversation, its timeline and its canvas history from the app. The agent's own session files stay on disk.",
  deleteConversationArmed: "Click again to delete this conversation. The agent's own session files stay on disk.",
  deleteProfileArmed: "Click again to delete this profile. Its conversations can continue with another profile.",
  splitter: "Drag to resize, double-click to reset.",
  queue:
    "Messages you send while the agent works wait here and go out one at a time, each when the turn before it ends (also after you press Stop).\n\nEdit moves a message back into the message box; ↑ in an empty box does the same for the last one. The queue lives in the host, so it survives a page reload but not a host restart.",
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

export const statusHints: Record<ConversationStatus, string> = {
  idle: "Idle: waiting for your next message.",
  starting: "Starting: the host is launching the agent process or resuming the session on it.",
  running: "Running: the agent is working on your message. Esc or Stop cancels the turn.",
  error: "Error: the agent could not start or resume. The details are under the header.",
};
