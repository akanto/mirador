import type { MachineColorStyle } from "./machine-colors.ts";
import type { Theme } from "./theme.ts";
import type { WaitingStyle } from "./waiting.ts";
import { workspaceColorVariables, type WorkspaceColorStyle } from "./workspace-colors.ts";

const Line = ({ width, strong = false }: { width: number; strong?: boolean }) => (
  <span className={`preview-line ${strong ? "strong" : ""}`} style={{ width: `${width}%` }} />
);

function MiniWindow({ scheme }: { scheme: "light" | "dark" }) {
  return (
    <span className={`preview-window theme-scope ${scheme}`}>
      <span className="preview-rail">
        <Line width={70} strong />
        <Line width={55} />
        <Line width={62} />
      </span>
      <span className="preview-chat">
        <span className="preview-bubble" />
        <Line width={90} />
        <Line width={70} />
      </span>
    </span>
  );
}

/** The app in the theme's own colours; matching the system shows light and dark split across the corner. */
export function ThemePreview({ theme }: { theme: Theme }) {
  if (theme !== "system") return <MiniWindow scheme={theme} />;
  return (
    <span className="preview-split">
      <MiniWindow scheme="light" />
      <MiniWindow scheme="dark" />
    </span>
  );
}

function WaitingRow({ style, waits }: { style: WaitingStyle; waits: boolean }) {
  return (
    <span className="preview-row">
      <span className={`preview-dot ${waits ? "waiting" : ""} ${waits && style === "dots" ? "glowing" : ""}`} />
      <Line width={waits && style === "dots" ? 62 : 48} strong={waits && style === "dots"} />
      {waits && style !== "dots" && <span className="preview-pill">Needs you</span>}
    </span>
  );
}

/** A workspace with one conversation waiting for a decision, marked the way the style marks it. */
export function WaitingPreview({ style }: { style: WaitingStyle }) {
  return (
    <span className="preview-sidebar">
      {style === "list" && (
        <span className="preview-waiting-list">
          <WaitingRow style={style} waits />
        </span>
      )}
      <span className="preview-card">
        <span className="preview-row heading">
          <Line width={50} strong />
          {style !== "dots" && <span className="preview-count">1</span>}
        </span>
        <WaitingRow style={style} waits />
        <WaitingRow style={style} waits={false} />
      </span>
    </span>
  );
}

/** A lavender workspace's card, coloured the way the style colours it. */
export function WorkspaceColorPreview({ style }: { style: WorkspaceColorStyle }) {
  return (
    <span className="preview-sidebar">
      <span className={`preview-card coloured-${style}`} style={workspaceColorVariables("lavender")}>
        <span className="preview-row heading">
          <span className="preview-mark">Mi</span>
          <Line width={50} strong />
        </span>
        <span className="preview-row">
          <Line width={70} />
        </span>
        <span className="preview-row">
          <Line width={55} />
        </span>
      </span>
    </span>
  );
}

/** A sky machine shown next to the rail, marked the way the style marks it. */
export function MachineColorPreview({ style }: { style: MachineColorStyle }) {
  return (
    <span className="preview-window" style={workspaceColorVariables("sky")}>
      <span className="preview-machine-rail">
        <span className="preview-rail-button" />
        <span className="preview-rail-button coloured" />
      </span>
      <span className={`preview-chat ${style === "strip" ? "striped" : ""}`}>
        <span className="preview-bubble" />
        <Line width={90} />
        <Line width={70} />
      </span>
    </span>
  );
}
