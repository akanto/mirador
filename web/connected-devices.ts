import { storedChoice } from "./stored-choice.ts";

const inSidebar = storedChoice<"shown" | "hidden">("mirador-connected-devices-in-sidebar", ["shown", "hidden"], "shown");

export const useConnectedDevicesInSidebar = () => inSidebar.use() === "shown";
export const setConnectedDevicesInSidebar = (shown: boolean) => inSidebar.set(shown ? "shown" : "hidden");
