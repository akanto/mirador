import { storedChoice } from "./stored-choice.ts";

const copyOnSelect = storedChoice<"on" | "off">("mirador-terminal-copy-on-select", ["on", "off"], "off");

export const useCopyOnSelect = () => copyOnSelect.use() === "on";
export const copiesOnSelect = () => copyOnSelect.get() === "on";
export const setCopyOnSelect = (on: boolean) => copyOnSelect.set(on ? "on" : "off");
