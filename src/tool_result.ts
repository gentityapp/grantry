// Build the MCP tools/call success result. Never truncate: clients that read
// only `content` (not `structuredContent`) must see the same full payload.
// Clients that read `structuredContent` (Claude Code) feed only that to the
// model, so the text copy does not add model tokens there.
export function providerToolResult(result: any) {
  return {
    content: [{ type: "text", text: JSON.stringify(result?.structuredContent ?? result) }],
    structuredContent: result?.structuredContent,
    isError: false,
  };
}
