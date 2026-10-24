import { tallyText } from "./tally-text.ts";

declare const mirador: { onState(listener: (state: { document: { count: number } }) => void): void; apply(operation: unknown): void };

const tally = document.createElement("output");
tally.id = "tally";
const add = document.createElement("button");
add.textContent = "Add one";
add.addEventListener("click", () => mirador.apply({ op: "add", by: 1 }));
document.body.append(tally, add);
mirador.onState((state) => (tally.textContent = tallyText(state.document.count)));
