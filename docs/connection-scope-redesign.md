# Connection / Scope redesign (proposal B)

Status: **proposal, not decided**. Written to be argued with — reviewers should attack the premises, not polish the wording.

Author context: raised 2026-08-07 after PR #117 added `/connections/new`, which fixed the *entry point* ("you had to create a scope to create a connection") without touching the underlying model. This doc is about the model.

---

## 1. What is true today

Facts below are from the code at `main` (post #118), with file references. Reviewers: verify these first — the rest of the doc collapses if any are wrong.

### 1.1 Connection is tenant-bound at the schema level

`prisma/schema.prisma` `model Connection`:

```
scope     String  @default("")   // denormalized tenant slug, immutable, always == tenant.slug
tenantId  String?                // null only for legacy unscoped (scope="") rows
```

A connection cannot exist without a tenant except for legacy `scope=""` rows. Every create path (`add_service`, `/tenants/new`, `grantry/create_connection`, OAuth callback) writes both fields.

### 1.2 The authorization unit is the connection, not the scope

`AgentConnectionGrant` is keyed `@@id([agentId, connectionId])`. `checkAccess` (`src/policy.ts:88`) builds:

```
provider IN compatibleProviderKeys(provider)
scope
enabled
[id]  [authType]
+ agentGrants: { some: { agentId } }        // unless agent.fullScopeManager
+ workspaceId (else ownerId)
```

Dropping `scope` from that `where` would not grant access to anything the agent was not already granted — the grant row and the workspace boundary are the gates. Scope acts as a **selector**, and its removal would instead surface as `ambiguous granted connections` (`src/policy.ts:112`) whenever an agent holds two connections for the same provider.

Exception: `fullScopeManager` agents bypass grants entirely and match on `scope: { not: "" }` (`src/policy.ts:147`). For those, scope is the only filter.

### 1.3 So scope currently earns its keep in exactly three ways

1. **Call-time addressing.** The human-readable key an agent sends as `scope` / `X-Grantry-Scope` (`src/mcp.ts:143`) to pick *which* of its connections to use. `connection_id` is already accepted as an alternative selector by `checkAccess`.
2. **Bulk administration.** `grantry/grant_scope` / `revoke_scope`, `grantConnectionToTenantAgents` (auto-granting a new connection to the scope's agents, `src/ui.ts:5959`), and the whole scope-page UI.
3. **`fullScopeManager` filtering.**

Scope is **not** the customer/data boundary — Workspace is. Tenant-level op policy was deliberately removed 2026-06-17, so Tenant carries no policy today.

### 1.4 Reusing one credential across scopes duplicates rows and secrets

`createTenantConnectionFromCredential` (`src/provider_credentials.ts:110`) creates a **new Connection row per tenant**, copying `encryptedCredential`, `refreshToken`, `accessTokenExpiresAt`, metadata and health snapshot from the shared `ProviderCredential`.

Consistency is maintained by fan-out writes, not by single ownership:

- rotation: `rotateSharedCredential` updates the credential + `connection.updateMany({ where: { credentialId } })` (`src/provider_credentials.ts:185`).
- runtime OAuth refresh: same transaction shape (`src/mcp.ts:4261`).

Runtime already **prefers the shared credential** when `credentialId` is set (`src/mcp.ts:4225-4240`: `shared?.encryptedCredential ?? conn.encryptedCredential`). The connection's own secret columns are effectively a legacy fallback for un-promoted rows.

### 1.5 Consequences of 1.1 + 1.4 that users actually feel

- N scopes × 1 provider = N connection rows, N copies of the same encrypted secret, N health rows to look at, N things to revoke.
- "Add this Slack to one more scope" is modeled as *create another connection*, which is why the product reads as scope-first.
- Health/status is per row, so the same credential can show up healthy in one scope and stale in another between fan-out writes.

---

## 2. Problem statement

The model conflates three separable things:

| Concern | Today | Should be |
|---|---|---|
| Who owns the secret | `ProviderCredential` (workspace) **and** a copy on every `Connection` | credential, single row |
| What an agent is granted | `AgentConnectionGrant` → one `Connection` | a connection (unchanged) |
| How an agent names its target at call time | `scope`, which is also the connection's identity | a routing label, N:M |

Because scope is baked into the connection's identity, "same credential, different routing label" forces a row copy.

## 3. Proposal B

**Make Connection workspace-owned; move the tenant relation to a join table; keep grants per connection.**

### 3.1 Schema

```prisma
model Connection {
  // scope    String   ← drop (keep temporarily as read-only denormalization)
  // tenantId String?  ← drop
  workspaceId String     // becomes required
  credentialId String    // becomes required; connection stops storing its own secret copy
  tenants     TenantConnection[]
}

model TenantConnection {
  tenantId     String
  connectionId String
  createdAt    DateTime @default(now())
  @@id([tenantId, connectionId])
  @@index([connectionId])
}
```

`AgentConnectionGrant` is unchanged — the grant unit stays the connection, which is what it already is.

Scope becomes an explicit **routing tag**: a connection can carry several, or none (reachable by `connection_id`).

### 3.2 Runtime

`checkAccess` resolves the tenant→connection set through the join instead of `connection.scope`:

```
agentGrants some { agentId }
+ workspaceId
+ (scope ? tenants: { some: { tenant: { slug: scope } } } : {})
```

Same allow/deny outcomes as today for every existing row (each connection has exactly one tenant after migration). Ambiguity handling and `connection_id` / `auth_type` disambiguation are untouched.

`fullScopeManager` needs a new definition — `scope: { not: "" }` disappears. Simplest equivalent: "every connection in the agent's workspace that has at least one tenant tag".

### 3.3 Secrets

Connection stops carrying `encryptedCredential` / `refreshToken` / `accessTokenExpiresAt` / health snapshot; those live only on `ProviderCredential`. This deletes the fan-out writes in `rotateSharedCredential` and the runtime refresh path, and removes the "healthy here, stale there" class of bug.

`connectionConfig` (per-connection `{var}` values, e.g. OneStream `teamId`) **stays on Connection** — it is genuinely per-binding, not per-credential.

### 3.4 UI / MCP surface

- `/connections/new`: scope step becomes multi-select tags, optional.
- Scope page keeps working, backed by the join.
- Attaching an existing connection to another scope becomes a join-row insert — no credential re-entry, no duplicate row. (Today's "reuse existing credential" select on the connect page becomes unnecessary.)
- `grantry/grant_scope` keeps its meaning: grant every connection tagged with that scope.
- `grantry/create_connection` takes an optional `scopes: string[]` instead of a required `target_scope`.

### 3.5 Migration phases

1. Add `TenantConnection`; backfill one row per existing `(tenantId, id)`. Dual-write on every create path. No reads change.
2. Switch reads (`checkAccess`, `connectionsForAgent`, scope pages, `/api/scopes`) to the join. `Connection.scope` becomes read-only denormalization.
3. Make `credentialId` required; backfill un-promoted rows via `ensureProviderCredentialForConnection`; stop writing secret columns on Connection.
4. Collapse duplicate connections that share `(workspaceId, credentialId, provider, authType)` into one connection with several tenant tags — **this is the destructive step**; grants must be re-pointed and audit rows preserved.
5. Drop `Connection.scope` / `tenantId` / secret columns.

Phases 1-3 are individually shippable and reversible. Phase 4 is not.

## 4. Alternatives considered

- **A (shipped, #117): fix the entry point only.** Provider-first `/connections/new` + credential reuse. Cheap, no migration, and it removed the day-to-day pain. Leaves row duplication and per-scope secret copies in place.
- **C: delete scope entirely, address by `connection_id`.** Honest to the authorization model (§1.2), but agents would have to carry cuids in prompts, `grant_scope`/bulk operations lose their unit, and `fullScopeManager` loses its definition. Rejected unless a stable human-readable connection alias replaces it.
- **D: keep the model, dedupe secrets only** (Connection → credential pointer, no join table). Fixes §1.4 without touching §1.1. Cheaper than B; still one row per scope, so the product still reads scope-first.

## 5. Open questions for reviewers

1. Is §1.2 right that scope adds **no** authorization power beyond the grant + workspace boundary? Any code path where a scope mismatch is the only thing denying a call? (`fullScopeManager` is the suspicious one.)
2. Is phase 4 (collapsing duplicates) worth it, or should identical-credential connections stay separate rows forever so that per-binding revocation and audit history remain naturally separated?
3. Should a connection be allowed **zero** tenant tags (reachable only by `connection_id`)? It simplifies the model and breaks the "everything is discoverable by scope" assumption in the UI.
4. Does anything depend on `Connection.scope` being immutable in a way a mutable tag set would break — audit queries, usage rollups, `audit_log` joins, MCP tool-name derivation?
5. Is D (secrets-only dedupe) the right stopping point? It gets most of the correctness win for a fraction of the migration risk.
6. Per-binding health: with secrets centralized, does health become per-credential only? Some providers fail per-binding (wrong `teamId`), so we may still need a per-connection check result.

## 6. Non-goals

- Reintroducing op-level policy on Tenant (removed 2026-06-17, deliberately).
- Changing the Workspace boundary. Workspace stays the customer/data boundary.
- Changing the wire protocol for existing agents: `scope` / `X-Grantry-Scope` keeps working throughout.
