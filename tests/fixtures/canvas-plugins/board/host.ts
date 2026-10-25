import type { CanvasHost, CanvasPluginContext } from "../../../../shared/canvas-plugins.ts";

/**
 * The smallest canvas plugin for testing Mirador's: a card among the pages, which the user presses and the agent hears
 * of, and steps in the tab, which the agent ticks off.
 */
type Card = { text: string; presses: number; heardPresses: number };
type Steps = { steps: string[]; done: number };
type BoardData = Card | Steps;

const newest = (context: CanvasPluginContext<BoardData>, type: string) => context.items().findLast((item) => item.type === type && !item.dismissed);

const host: CanvasHost<BoardData> = {
  items: {
    card: { icon: "▤", placement: "page" },
    steps: { icon: "◔", placement: "tab", count: (data) => `${(data as Steps).done}/${(data as Steps).steps.length}` },
  },
  tools: {
    show_card: {
      description: "Show a card the user can press.",
      input: { type: "object", properties: { title: { type: "string", minLength: 1 }, text: { type: "string" } }, required: ["title", "text"] },
      run(input, { publish }) {
        const { title, text } = input as { title: string; text: string };
        return `Shown as ${publish({ type: "card", title, data: { text, presses: 0, heardPresses: 0 } }).id}.`;
      },
    },
    change_card: {
      description: "Change the text of the newest card.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run(input, context) {
        const card = newest(context, "card");
        if (!card) throw new Error("There is no card to change; show one with show_card.");
        context.change(card.id, { data: { ...(card.data as Card), text: (input as { text: string }).text } });
        return "Changed.";
      },
    },
    track_steps: {
      description: "Track steps in the tab beside the canvas.",
      input: { type: "object", properties: { title: { type: "string" }, steps: { type: "array", items: { type: "string" } } }, required: ["title", "steps"] },
      run(input, { publish }) {
        const { title, steps } = input as { title: string; steps: string[] };
        publish({ type: "steps", title, data: { steps, done: 0 } });
        return `Tracking ${steps.length} steps.`;
      },
    },
    finish_step: {
      description: "Tick off the next step.",
      input: { type: "object", properties: {} },
      run(_input, context) {
        const steps = newest(context, "steps");
        if (!steps) throw new Error("There are no steps to tick off.");
        const data = steps.data as Steps;
        context.change(steps.id, { data: { ...data, done: data.done + 1 } });
        return `${data.done + 1} done.`;
      },
    },
  },
  guidance: {
    instructions: "- show_card: show a card the user can press.",
    often: "- show_card: when a card says it better than words.",
  },
  action(item, action, context) {
    if ((action as { kind?: unknown }).kind !== "press" || item.type !== "card") throw new Error("A card can only be pressed.");
    const card = item.data as Card;
    const pressed = context.change(item.id, { data: { ...card, presses: card.presses + 1 } });
    return { presses: (pressed.data as Card).presses };
  },
  note(context) {
    const card = newest(context, "card");
    const data = card?.data as Card | undefined;
    if (!card || !data || data.presses === data.heardPresses) return null;
    return {
      text: `The user pressed the card "${card.title}" ${data.presses - data.heardPresses} times.`,
      heard: () => {
        const latest = context.items().find(({ id }) => id === card.id)!;
        context.change(card.id, { data: { ...(latest.data as Card), heardPresses: data.presses } });
      },
    };
  },
};

export default host;
