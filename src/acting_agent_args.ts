import { isAdminTool } from "./admin_tools.js";

/**
 * `acting_agent_id` selects which agent an authenticated *user* acts through on
 * `/mcp/u`; it is never a provider parameter, so it is always stripped.
 *
 * `agent_id` is different: it is a real parameter of the grantry admin tools
 * (set_runbook / update_agent / rotate_agent_token / grant_scope ...), where it
 * names the *target* agent. It doubles as an acting-agent selector only in user
 * mode, and even there not for the admin tools. Stripping it unconditionally
 * made every admin tool fail with `'agent_id' is required`.
 */
export function stripActingAgentSelector<T extends Record<string, unknown>>(
  args: T,
  opts: { userMode: boolean; toolName: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  delete out.acting_agent_id;
  delete out.actingAgentId;
  if (opts.userMode && !isAdminTool(opts.toolName)) {
    delete out.agent_id;
    delete out.agentId;
  }
  return out;
}

/**
 * True when `agent_id` in this call names the target agent rather than the
 * agent the user is acting through, so user-mode agent selection must ignore it.
 */
export function agentIdIsToolTarget(toolName: string): boolean {
  return toolName === "grantry/delegate" || isAdminTool(toolName);
}
