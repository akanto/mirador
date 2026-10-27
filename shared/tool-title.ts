/** An MCP tool's call as "server · tool", or for a plugin's tool on the canvas server, "plugin's title · tool". */
export function readableToolTitle(title: string, pluginToolTitles: Record<string, string>) {
  const mcpTool = title.match(/^mcp__(.+?)__(.+)$/);
  if (!mcpTool) return title;
  const [, server = "", tool = ""] = mcpTool;
  const plugin = server === "canvas" ? pluginToolTitles[tool] : undefined;
  return `${plugin ?? server} · ${tool}`;
}
