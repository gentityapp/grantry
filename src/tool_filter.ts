// Client-requested narrowing of the MCP tool surface.
//
// MCP clients such as Claude Code load every tool definition a server
// advertises into the model context; `--allowedTools` only gates calls. A
// full-scope agent advertises ~580 tools (~700 KB of JSON), which overflows a
// 200k-context model before the routine starts. A connection can therefore ask
// for a subset:
//
//   /mcp?providers=google_ads,meta_ads&tools=slack_post_message
//   X-Grantry-Providers: google_ads,meta_ads
//   X-Grantry-Tools: slack_post_message
//
// The filter is display narrowing only. It is applied AFTER authorization
// (the list is already limited to the agent's grants/scope), so naming a tool
// the agent is not granted never makes it appear. Calls to tools outside the
// requested subset are refused too, so the advertised list and the callable
// set stay identical. No parameters = no filter (backward compatible).

import { normalizeToolName } from "./policy.js";

export type ToolFilter = {
  providers: Set<string>;
  tools: Set<string>;
};

// Always kept so clients can health-check a narrowed connection.
const ALWAYS_KEPT = new Set(["ping"]);

function splitList(values: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const part of value.split(",")) {
      const item = part.trim().toLowerCase();
      if (item) out.push(item);
    }
  }
  return out;
}

/** Canonical "provider/tool" form for either the public or canonical name. */
function canonical(name: string): string {
  if (name === "ping" || name.includes("/")) return name;
  // System tools (grantry_get_runbook, ...) are not in the provider registry.
  if (name.startsWith("grantry_")) return `grantry/${name.slice("grantry_".length)}`;
  return normalizeToolName(name);
}

export function parseToolFilter(input: {
  providers?: (string | undefined | null)[];
  tools?: (string | undefined | null)[];
}): ToolFilter | null {
  const providers = splitList(input.providers ?? []);
  const tools = splitList(input.tools ?? []).map(canonical);
  if (!providers.length && !tools.length) return null;
  return { providers: new Set(providers), tools: new Set(tools) };
}

/** Read the filter from query parameters and X-Grantry-* headers of a Hono context. */
export function toolFilterFromRequest(c: any): ToolFilter | null {
  const queries = (key: string): string[] => {
    try {
      return (c.req.queries?.(key) as string[] | undefined) ?? [];
    } catch {
      return [];
    }
  };
  return parseToolFilter({
    providers: [...queries("providers"), c.req.header("x-grantry-providers")],
    tools: [...queries("tools"), c.req.header("x-grantry-tools")],
  });
}

export function toolAllowedByFilter(filter: ToolFilter | null, name: string): boolean {
  if (!filter) return true;
  if (ALWAYS_KEPT.has(name)) return true;
  const canon = canonical(name);
  if (filter.tools.has(canon)) return true;
  const slash = canon.indexOf("/");
  return slash > 0 && filter.providers.has(canon.slice(0, slash));
}

export function applyToolFilter<T extends { name: string }>(tools: T[], filter: ToolFilter | null): T[] {
  if (!filter) return tools;
  return tools.filter((tool) => toolAllowedByFilter(filter, tool.name));
}

// ---------- Helper consolidation ----------
//
// Every generic provider advertises `<provider>_check_connection` and
// `<provider>_list_capabilities` (~110 near-identical tools on a full-scope
// token). With `?helpers=consolidated` (or header X-Grantry-Helpers:
// consolidated) tools/list replaces them with one `grantry_check_connection` /
// `grantry_list_capabilities` taking `provider`. Opt-in, because runner
// routines list the per-provider names in --allowedTools (2026-09-13: 50+
// references) and Claude Code cannot call a tool it was not advertised.
// Per-provider names stay callable either way.

export const HELPER_ACTIONS = ["check_connection", "list_capabilities"] as const;

export function helpersConsolidated(c: any): boolean {
  let q = "";
  try { q = String(c.req.query?.("helpers") ?? ""); } catch { q = ""; }
  const value = (q || String(c.req.header?.("x-grantry-helpers") ?? "")).trim().toLowerCase();
  return value === "consolidated";
}

/** `grantry/check_connection` + provider -> `provider/check_connection`; otherwise unchanged. */
export function expandConsolidatedHelper(toolName: string, args: Record<string, unknown>): string {
  for (const action of HELPER_ACTIONS) {
    if (toolName === `grantry/${action}`) {
      const provider = String(args.provider ?? "").trim().toLowerCase();
      return provider ? `${provider}/${action}` : toolName;
    }
  }
  return toolName;
}

export function consolidateHelperTools<T extends { name: string; inputSchema?: any }>(tools: T[]): any[] {
  const kept: any[] = [];
  const byAction = new Map<string, { providers: Set<string>; scopes: Set<string> }>();
  for (const tool of tools) {
    const canon = canonical(tool.name);
    const slash = canon.indexOf("/");
    const action = slash > 0 ? canon.slice(slash + 1) : "";
    const provider = slash > 0 ? canon.slice(0, slash) : "";
    if (provider && provider !== "grantry" && (HELPER_ACTIONS as readonly string[]).includes(action)) {
      const entry = byAction.get(action) ?? { providers: new Set<string>(), scopes: new Set<string>() };
      entry.providers.add(provider);
      for (const s of tool.inputSchema?.properties?.scope?.enum ?? []) entry.scopes.add(String(s));
      byAction.set(action, entry);
      continue;
    }
    kept.push(tool);
  }
  for (const action of HELPER_ACTIONS) {
    const entry = byAction.get(action);
    if (!entry) continue;
    kept.push({
      name: `grantry_${action}`,
      description: action === "check_connection"
        ? "Check a granted provider connection (auth + reachability)."
        : "List a provider's capabilities: base URLs, allowed methods, example requests.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: Array.from(entry.providers).sort() },
          scope: { type: "string", enum: Array.from(entry.scopes).sort(), description: "Tenant scope." },
          connection_id: { type: "string" },
        },
        required: ["provider"],
      },
    });
  }
  return kept;
}
