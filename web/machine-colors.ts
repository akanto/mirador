import { storedChoice } from "./stored-choice.ts";

export type MachineColorStyle = "rail" | "strip";

export const machineColorStyleLabels: Record<MachineColorStyle, string> = {
  rail: "Rail button only",
  strip: "Rail button and a strip on its view",
};

const machineColorStyle = storedChoice<MachineColorStyle>("mirador-machine-colors", ["rail", "strip"], "strip");

export const setMachineColorStyle = machineColorStyle.set;
export const useMachineColorStyle = machineColorStyle.use;
