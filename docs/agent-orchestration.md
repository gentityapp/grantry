# Agent orchestration: capability discovery & routing

Status: **implemented (stages 1–4).** The lookup, the `find_agent`/`route`
system tools, the enriched denial, and capability-scoped `delegate` are all in
place. Requires `npm run db:push` (new `DelegationGrant` table + `AuditLog`
delegation columns).
Audience: grantry maintainers

## The problem

grantry already answers *"what can **this** agent do?"* — `tools/list` is scoped
to the calling agent, and `/api/scopes` dumps an owner's full wiring. What it
does **not** answer is the inverse, fleet-wide question:

> *"I want to do X. **Which** agent can do it?"*

This bites the moment work spans more than one narrowly-scoped agent (the
recommended posture: one agent per tenant/connection grant set). Concrete case
that motivated this doc: a session scoped only to the `seo-marketer` tenant
needed to set an env var on grantry's own prod Railway project. The agent that
*could* do it existed somewhere in the fleet, but there was no way to find it.

It's the same question — *"who can do X?"* — that shows up in two places:

- **At the entry point**, before any call: *"who do I even talk to for this?"*
- **At a mid-task dead-end**, after a denial: a denied `tools/call` is a full
  stop, not a signpost toward who *could* have done it.

This is a **capability discovery + routing** problem, not an authorization one.

## What already exists (reuse, don't rebuild)

The data to answer "who can do X" is already in the schema:

| Source | What it gives us |
| --- | --- |
| `AgentConnectionGrant(agentId, connectionId)` | which connections an agent may use |
| `Connection(provider, scope, enabled)` | which provider connections are actually live per scope |
| `Connection.credentialMetadata` | observed provider scopes/capabilities (read vs write hints), never the raw token |
| `AuditLog` | every `tools/call` records `agent`, `connection`, `provider`, `tool`, `scope`, `status` |

So the whole thing is one inverse-lookup predicate:

```
capable(agent, tool, scope) ⇔
    provider(tool) implements tool
  ∧ ∃ AgentConnectionGrant(agent, connection)
  ∧ connection.provider = provider(tool)
  ∧ connection.scope = scope
  ∧ connection.enabled = true
  ∧ agent/workspace boundary matches connection
```

`provider(tool)` is the prefix of the tool name (`railway/graphql` → `railway`),
already used for routing in `mcp.ts`. Everything below is a thin surface over
this one query.

## Proposal

### The lookup

`capable(...)` exposed as a structured query, scoped to the **workspace** (the
management wall, per `docs/workspace-design.md`). Returns ranked agent
identities and capability facts — **never tokens**.

```
GET /api/capabilities?tool=railway/graphql&scope=grantry-prod&action=write
→ [{ agentId, name, grants, scopes, connection: { authType, enabled }, confidence }]
```

Ranking signals: exact-scope vs `[]`-any match, connection `enabled` +
`credentialValidatedAt` freshness, `credentialMetadata` action (read/write)
match, recent success in `AuditLog`.

`grantry_find_agent` dedupes by **connection**, not agent: many agents sharing
one connection collapse to a single candidate so they can't fill the result cap and
hide the unique connection that actually reaches the target (issue #47). On top
of the structural signal it ranks by overlap between the task text and each
connection's **scope / label / project name** (not the tool name alone), and
penalizes candidates that match a contested target not at all — so the reported
confidence varies with target fit instead of saturating at a constant.

### Two surfaces over it

Same lookup, two places it shows up — differing only in how it's triggered:

1. **A system tool** (alongside `grantry_get_providers` / `grantry_get_skill`),
   for the entry-point case — ask before you start:
   - `grantry_find_agent(task)` — NL in, ranked candidates out (translates the
     task to a `(tool, scope, action)` guess, then runs the lookup).
   - `grantry_route(tool, scope?, action?)` — the structured lookup directly,
     when the caller already knows the tool.

2. **An enriched denial in `mcp.ts`**, for the dead-end case — when a
   `tools/call` is rejected for lack of permission/connection, attach who
   *could* do it instead of returning a bare error:

   ```jsonc
   {
     "error": "agent `seo-marketer` cannot call railway/graphql on scope grantry-prod",
     "capableAgents": [{ "name": "infra-ops", "grantedScopes": ["grantry-prod"], "connection": "live" }]
   }
   ```

   The user never has to know `grantry_find_agent` exists; the failure carries
   the answer.

### Capability-scoped delegation

Turns "who can" into "done" — **without grantry becoming an orchestrator.**
grantry is a gate and a permission manager, not an execution engine; the
execution subject is the calling agent (or a sub-agent it spawns), and grantry
must not act as a peer on its own initiative. So delegation is split in two:

1. **Mint** — `grantry_delegate(agent_id, tool, scope)` validates the request
   and returns a **one-time, time-boxed grant token** (`gn_grant_…`). It runs
   `checkPolicy` against the target so a stale `find_agent` answer can't
   authorize anything, and persists only the token *hash* in `DelegationGrant`.
   It executes nothing.
2. **Redeem** — the agent (or a sub-agent using its token) makes a *normal*
   `tools/call` for that tool, passing `grant_token` in the arguments. grantry
   gates it exactly as any call, but on a valid grant it routes through the
   target agent's connection and consumes the grant. The agent drove the call;
   grantry only honored a scoped permission slip.

   For this to be callable from a standard MCP client, `tools/list` advertises
   not just the agent's *directly* usable tools but also tools reachable **only
   by delegation** — those a capable peer under the same owner holds. Such
   entries are flagged `(delegated — …)` and require a `grant_token`; calling one
   without a grant is denied (with a capable-peer signpost). Otherwise the agent
   would have no discoverable tool to attach the grant to — `delegatableToolsForAgent`
   in `src/policy.ts` computes this set, owner-bounded to match minting.

This keeps the boundary clean: orchestration ("I'm stuck → get a grant → run
it") lives in the agent layer; grantry only ever answers "who can" and "is this
specific call permitted." (grantry still makes the outbound provider request —
it holds the credential and never leaks it — but that is true of *every* call
and is the point of the gateway.)

Guardrails:

- **Owner-bounded.** A grant never crosses owners: `target.ownerId` must equal
  the requester's. (Discovery is workspace-wide, but borrowing a peer's
  authority is the stronger act; cross-owner delegation is left open.)
- **Least privilege.** A grant authorizes one `(tool, scope)`, nothing else;
  redemption rejects any mismatch.
- **Single-use + time-boxed.** Burned on redemption (even on failure);
  `DELEGATION_TTL_MS` short by design.
- **Bound to the requester.** Only the agent the grant was issued to may redeem
  it; the secret token is stored hashed and returned once.
- **Re-checked at redemption.** `checkPolicy` runs against the target again, so
  a connection grant change between mint and redeem revokes the grant.
- **Audited end to end.** The redeemed `AuditLog` row is under the *target*
  (executing) agent with `delegatedById` (the requester) and `delegationId`.
- **No token exposure.** The requester never sees the target's credential.
- **Confirm gate.** MCP has no server-side prompt, so the human confirm before
  minting/redeeming is the calling client's responsibility.

## Build order

1. **Lookup** — `findCapableAgents()` in `src/policy.ts` + `GET
   /api/capabilities` in `src/ui.ts`. ✅ shipped.
2. **System tools** — `grantry_find_agent` / `grantry_route` in `src/mcp.ts`
   (token-required system tools). ✅ shipped.
3. **Enriched denial** — `-32010` responses now carry `data.capableAgents` when
   a capable peer exists in the workspace. ✅ shipped.
4. **Delegation** — `grantry_delegate` (mint) + `grant_token` redemption on the
   normal `tools/call` path + `DelegationGrant` in `src/mcp.ts` /
   `prisma/schema.prisma`. Owner-bounded, single-use, audited; grantry mints,
   the agent redeems. ✅ shipped.

Stages 1–3 remove the friction (the stuck session would have been told exactly
who to ask); 4 closes the loop. The discovery lookup deliberately does **not**
use `AuditLog` success history for ranking yet — see open questions.

## Open questions

- **Action inference.** Tag a tool read vs write via a static map in the
  provider registry, or lean on `credentialMetadata` observed scopes? Probably
  both.
- **Visibility grain.** Workspace-wide is the default — do we ever want
  cross-workspace routing, and under whose authority?
- **Denial signpost scope.** Fire on every denial, or only when a capable agent
  actually exists (so we don't leak "nobody can do this")? *(Currently: only
  when a capable peer exists.)*
- **Cross-owner delegation.** `delegate` is owner-bounded today. Should a
  workspace owner/admin be able to delegate across owners within the workspace,
  and how is that consent captured?

## Why this fits grantry

The building blocks are already here — connection grants, scopes, connections, audit log,
system tools. This adds one **index** over them, surfaced as a tool you can ask
and a hint on denials, plus an optional **narrow handoff**. The
`*-full-manager-routine` agent naming already hints at an intended orchestrator;
this gives that agent real primitives instead of one token hoarding every
permission.
