import { workspaceColorLabels, type WorkspaceColor } from "../shared/model.ts";
import { workspaceColors, workspaceColorVariables } from "./workspace-colors.ts";

/** The pastels a workspace or a machine can take, and No colour; the one chosen takes the focus. */
export function ColorSwatches({ label, chosen, onChoose }: { label: string; chosen: WorkspaceColor | null; onChoose: (color: WorkspaceColor | null) => void }) {
  return (
    <div className="color-swatches" role="radiogroup" aria-label={label}>
      {[null, ...workspaceColors].map((color) => (
        <button
          key={color ?? "none"}
          type="button"
          role="radio"
          aria-checked={chosen === color}
          aria-label={color ? workspaceColorLabels[color] : "No colour"}
          className={color ? "swatch" : "swatch no-color"}
          style={color ? workspaceColorVariables(color) : undefined}
          autoFocus={chosen === color}
          onClick={() => onChoose(color)}
        />
      ))}
    </div>
  );
}
