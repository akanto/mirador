import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { openOutsideLinksInTheBrowser } from "./outside-links.ts";
import { applyTheme, storedTheme } from "./theme.ts";
import { applyTimestampsShown, storedTimestampsShown } from "./timestamps.ts";
import { applyWaitingStyle, storedWaitingStyle } from "./waiting.ts";
import { applyWorkspaceColorStyle } from "./workspace-colors.ts";

applyTheme(storedTheme());
applyTimestampsShown(storedTimestampsShown());
applyWaitingStyle(storedWaitingStyle());
applyWorkspaceColorStyle();
openOutsideLinksInTheBrowser();
createRoot(document.getElementById("root")!).render(<App />);
