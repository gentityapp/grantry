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
