import type { HarnessId } from "../shared/model.ts";
import { storedChoice } from "./stored-choice.ts";

/** What Enter does with a message while the agent works; ⌥Enter does the other. */
export type EnterWhileBusy = "steer" | "after-turn";

export const enterWhileBusyLabels: Record<EnterWhileBusy, string> = {
  steer: "Adds the message to the running turn",
  "after-turn": "Sends the message after the turn ends",
};

/** Claude Code takes messages into a running turn (ACP steering); opencode and pi only between turns. */
export const harnessSteers: Record<HarnessId, boolean> = { claude: true, opencode: false, pi: false };

const enterWhileBusy = storedChoice<EnterWhileBusy>("mirador-enter-while-busy", ["steer", "after-turn"], "steer");

export const setEnterWhileBusy = enterWhileBusy.set;
export const useEnterWhileBusy = enterWhileBusy.use;
