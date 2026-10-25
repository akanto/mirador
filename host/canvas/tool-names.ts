/** None of them changes files or runs commands for the agent, so none is worth a permission prompt. */
export const PRE_ALLOWED_CANVAS_TOOLS = ["show", "ask", "review", "update_review", "when_done"];

const APP_TOOLS = ["app_open", "apply", "app_state", "app_run"];

/** The canvas server's own tools, whose names a plugin's tools can't take. */
export const BUILT_IN_CANVAS_TOOLS = [...PRE_ALLOWED_CANVAS_TOOLS, ...APP_TOOLS];
