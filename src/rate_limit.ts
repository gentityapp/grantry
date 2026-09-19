// Per-agent sliding-window rate limit for tools/call. In-memory: fine for a
// single instance; the goal is abuse damping for a leaked token, not quota
// accounting. Set MCP_RATE_LIMIT_PER_MINUTE=0 to disable.
//
// One token can legitimately front many workers (a fleet runner shares one
// agent across hundreds of loops). The default then starves everything behind
// that token, including safety watchers. MCP_RATE_LIMIT_OVERRIDES raises (or
// lowers, or with 0 disables) the limit for named agents only, so every other
// token keeps the default damping:
//   MCP_RATE_LIMIT_OVERRIDES="<agent id>=1200,<agent id>=0"

export type RateLimitConfig = {
  defaultPerMinute: number;
  overrides: Map<string, number>;
};

export type RateLimitDecision = {
  limited: boolean;
  limit: number;
  retryAfterSec: number;
};

export function parseRateLimitOverrides(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of String(raw ?? "").split(",")) {
    const eq = part.lastIndexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const text = part.slice(eq + 1).trim();
    const value = Number(text);
    // A typo must not silently disable the limit: only a well-formed non-negative integer counts.
    if (!key || text === "" || !Number.isInteger(value) || value < 0) continue;
    out.set(key, value);
  }
  return out;
}

export function rateLimitConfigFromEnv(env: Record<string, string | undefined> = process.env): RateLimitConfig {
  return {
    defaultPerMinute: Number(env.MCP_RATE_LIMIT_PER_MINUTE ?? 120),
    overrides: parseRateLimitOverrides(env.MCP_RATE_LIMIT_OVERRIDES),
  };
}

// Keyed by agent id only: names are chosen by tenants, so a name match would let
// anyone lift their own limit by naming an agent after an overridden one.
export function limitForAgent(config: RateLimitConfig, agent: { id: string }): number {
  const byId = config.overrides.get(agent.id);
  return byId !== undefined ? byId : config.defaultPerMinute;
}

export class AgentRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(private config: RateLimitConfig = rateLimitConfigFromEnv()) {}

  check(agent: { id: string }, now: number = Date.now()): RateLimitDecision {
    const limit = limitForAgent(this.config, agent);
    if (!limit || !Number.isFinite(limit)) return { limited: false, limit: 0, retryAfterSec: 0 };
    const cutoff = now - 60_000;
    let window = this.windows.get(agent.id);
    if (!window) {
      window = [];
      this.windows.set(agent.id, window);
    }
    while (window.length && window[0] < cutoff) window.shift();
    if (window.length >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((window[0] + 60_000 - now) / 1000));
      return { limited: true, limit, retryAfterSec };
    }
    window.push(now);
    return { limited: false, limit, retryAfterSec: 0 };
  }
}
