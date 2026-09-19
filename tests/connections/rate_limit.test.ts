import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentRateLimiter, limitForAgent, parseRateLimitOverrides, rateLimitConfigFromEnv } from "../../src/rate_limit.js";

const FLEET = { id: "agt_fleet" };
const OTHER = { id: "agt_other" };

test("default limit applies to an agent with no override", () => {
  const limiter = new AgentRateLimiter(rateLimitConfigFromEnv({ MCP_RATE_LIMIT_PER_MINUTE: "3" }));
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(limiter.check(OTHER, t0 + i).limited, false);
  const blocked = limiter.check(OTHER, t0 + 10);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.limit, 3);
});

// One token fronting many workers keeps the shared default window full, so
// low-volume callers behind the same token fail with -32029.
test("an overridden agent gets its own limit and does not starve behind the default", () => {
  const limiter = new AgentRateLimiter(rateLimitConfigFromEnv({
    MCP_RATE_LIMIT_PER_MINUTE: "120",
    MCP_RATE_LIMIT_OVERRIDES: "agt_fleet=1200",
  }));
  const t0 = 2_000_000;
  for (let i = 0; i < 1200; i++) assert.equal(limiter.check(FLEET, t0 + i).limited, false, `call ${i}`);
  assert.equal(limiter.check(FLEET, t0 + 1300).limited, true);
  // the default still damps every other token
  for (let i = 0; i < 120; i++) assert.equal(limiter.check(OTHER, t0 + i).limited, false);
  assert.equal(limiter.check(OTHER, t0 + 200).limited, true);
});

test("override 0 disables the limit for that agent only", () => {
  const limiter = new AgentRateLimiter(rateLimitConfigFromEnv({ MCP_RATE_LIMIT_PER_MINUTE: "2", MCP_RATE_LIMIT_OVERRIDES: "agt_fleet=0" }));
  for (let i = 0; i < 50; i++) assert.equal(limiter.check(FLEET, 5_000 + i).limited, false);
  limiter.check(OTHER, 5_000); limiter.check(OTHER, 5_001);
  assert.equal(limiter.check(OTHER, 5_002).limited, true);
});

test("retry_after tells the caller when the oldest call leaves the window", () => {
  const limiter = new AgentRateLimiter(rateLimitConfigFromEnv({ MCP_RATE_LIMIT_PER_MINUTE: "1" }));
  limiter.check(OTHER, 100_000);
  const blocked = limiter.check(OTHER, 100_000 + 45_000);
  assert.equal(blocked.limited, true);
  assert.equal(blocked.retryAfterSec, 15);
  assert.equal(limiter.check(OTHER, 100_000 + 60_001).limited, false);
});

test("malformed overrides are ignored instead of lifting the limit", () => {
  const overrides = parseRateLimitOverrides("agt_a=abc, agt_b=, =5, agt_c=-1, agt_d=1.5, agt_e=300 ,junk");
  assert.deepEqual(Array.from(overrides.entries()), [["agt_e", 300]]);
  const config = { defaultPerMinute: 120, overrides };
  assert.equal(limitForAgent(config, { id: "agt_a" }), 120);
  assert.equal(limitForAgent(config, { id: "agt_e" }), 300);
});

test("overrides never match by agent name", () => {
  const config = rateLimitConfigFromEnv({ MCP_RATE_LIMIT_OVERRIDES: "shared-runner=0" });
  assert.equal(limitForAgent(config, { id: "agt_x", name: "shared-runner" } as { id: string }), 120);
});
