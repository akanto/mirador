import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, storedTheme } from "./theme.ts";
import { applyTimestampsShown, storedTimestampsShown } from "./timestamps.ts";

applyTheme(storedTheme());
applyTimestampsShown(storedTimestampsShown());
createRoot(document.getElementById("root")!).render(<App />);
