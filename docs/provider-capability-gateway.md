# Provider Capability Gateway

Status: **design direction**.
Audience: grantry maintainers

## Why this exists

Grantry cannot become product-quality if every missing SaaS operation turns into
"the agent is stuck." The recurring failure mode is:

```
connection exists
agent has a grant
provider token may even have enough permissions
but Grantry has no tool for the API path the task needs
```

That is not only a connector coverage problem. It is a product model problem.
If Grantry hand-writes every provider operation as a one-off MCP tool, it will
always lag the long tail of SaaS APIs.

The product direction is therefore:

```
Grantry is a permissioned provider API gateway for agents,
not just a catalog of hand-written connector tools.
```

Curated tools still matter, but they sit on top of a generic provider capability
layer.

## Core principle

Every provider should get the same baseline capability:

```
provider credential
  -> provider manifest
  -> safe generic request
  -> policy + audit + masking
  -> optional generated and curated MCP tools
```

This gives all providers an escape hatch before Grantry has curated every API.
Provider-specific tools become product polish, not the only path to execution.

## Layers

### Layer 1: Generic provider request

Each implemented provider should eventually expose a generic request surface:

```
<provider>/request
```

Example:

```json
{
  "method": "GET",
  "path": "/marketing/v3/emails",
  "query": { "limit": 20 }
}
```

This must not be an open proxy. Guardrails:

- Base URL is fixed by Grantry's provider manifest.
- `path` must be relative, never a full URL.
- `..` and protocol-like path tricks are rejected.
- Default launch mode is read-only: `GET` only.
- Write methods require explicit provider policy.
- All calls require normal `AgentConnectionGrant` authorization.
- Request/response are audit logged with sensitive values masked.
- Response body size is capped.
- Host, method, path, status, duration, agent, tenant, and connection are logged.

### Layer 2: Manifest-backed capability discovery

Each provider should have a manifest that describes what Grantry knows about the
provider, even if Grantry has not curated every operation.

Shape:

```ts
type ProviderManifest = {
  provider: string;
  baseUrl: string;
  auth: {
    scheme: "bearer" | "api_key" | "basic" | "custom";
  };
  genericRequest: {
    enabled: boolean;
    defaultMethods: string[];
    allowedPathPrefixes: string[];
    blockedPathPrefixes?: string[];
  };
  operations?: Array<{
    id: string;
    method: string;
    path: string;
    description: string;
    requiredScopes?: string[];
    risk: "read" | "write" | "destructive";
  }>;
};
```

Long term, `operations` can be populated from OpenAPI specs, provider docs, or
curated YAML. The first usable version can be manually authored per provider.

### Layer 3: Generated MCP tools

For providers with OpenAPI or a rich manifest, Grantry can generate safe read
tools automatically:

```
hubspot/get_marketing_v3_emails
slack/get_conversations_history
salesforce/get_services_data_vXX_query
```

Generated tools should be opt-in per provider. Names may be less polished, but
they give agents discoverable operations without hand-written connector work.

### Layer 4: Curated tools

Frequently used, high-value, or complex operations should still become curated
tools:

```
hubspot/list_marketing_emails
hubspot/search_contacts
google_ads/search
notion/query_db
```

Curated tools provide better names, typed arguments, normalized responses, and
safer write flows. They are the product UX layer, not the coverage foundation.

## Authorization model

Generic requests do not bypass Grantry's existing security model.

Authorization still requires:

```
agent enabled
connection enabled
agent has AgentConnectionGrant(connection)
agent and connection share workspace boundary
requested provider matches connection.provider
requested scope matches connection.scope
provider manifest permits method/path
```

Provider-side permission remains the provider's responsibility. Grantry should
classify the failure clearly when possible:

| Error class | Meaning |
| --- | --- |
| `policy_denied` | Grantry denied agent/connection/scope access |
| `tool_not_implemented` | Grantry has no curated/generated operation |
| `provider_path_not_allowed` | Generic request guardrails rejected method/path |
| `provider_auth_invalid` | Token expired, revoked, or malformed |
| `provider_scope_missing` | Provider rejected due to missing scope/permission |
| `provider_plan_or_api_unavailable` | Provider API exists but account cannot use it |

The important product rule: never collapse these into a vague "permission
problem."

## UI implications

Connection settings should show three levels:

```
Credential status
Provider capabilities
Grantry tool coverage
```

Example:

```
HubSpot
  Credential: valid
  Generic request: GET enabled
  Curated tools:
    - list_deals
    - get_contact
    - create_deal
  Suggested missing capabilities:
    - marketing emails: available through generic request
    - marketing email stats: unknown until called
```

When a provider error indicates a missing scope, show a concrete remediation:

```
This HubSpot token cannot access /marketing/v3/emails.
Add the required Marketing Email permission to the Private App token,
then recheck the connection.
```

## MCP implications

`tools/list` should eventually expose:

1. Curated tools.
2. Generated tools, when enabled.
3. `<provider>/request` when generic request is enabled and the agent has a
   granted connection.

Agent instructions should prefer:

```
1. Use curated tools when they exist.
2. Use generated tools when the operation is discoverable.
3. Use provider/request for read-only API gaps.
4. Ask the user only when provider-side auth/scope/account access is missing.
```

## Rollout plan

### Phase 1: Read-only generic request

Build the minimum safe gateway:

- Add provider manifest fields for `baseUrl` and allowed path prefixes.
- Add `<provider>/request` for selected providers.
- Start with `GET` only.
- Keep response size caps and audit logs.
- Add error classification.

HubSpot is the first proving ground because it already exposed the failure:
marketing email APIs exist, but Grantry had no tool path to reach them.

### Phase 2: Capability metadata

Store capability observations on `Connection.credentialMetadata` or a successor
metadata model:

- Last successful paths.
- Last provider errors by path.
- Inferred missing scopes.
- Available account identifiers when safe.

This lets the dashboard and agents answer "can this connection probably do X?"
without rediscovering from scratch every time.

### Phase 3: Manifest operations and generated tools

Add operation metadata:

- Curated manifests for important providers.
- OpenAPI ingestion where practical.
- Generated read tools behind a feature flag.
- Tool naming conventions and deprecation rules.

### Phase 4: Controlled writes

Enable non-GET generic requests only with stronger controls:

- Explicit tenant/provider policy.
- Optional human confirmation marker in args.
- Path allowlist per provider.
- Destructive method/path blocklist.
- Higher audit detail.

Write support should be conservative. A generic write proxy is powerful and
must not become a silent footgun.

## Competitive posture

Competitors typically solve this with one of these patterns:

- Huge prebuilt action catalogs plus custom API request escape hatches.
- Toolkit SDKs where missing operations can be added as code.
- Auth/runtime platforms that generate provider actions.
- Dynamic tool marketplaces.

Grantry's version should be:

```
workspace-owned credentials
tenant-scoped agent grants
provider manifest
safe generic request
curated tools on top
audit and policy everywhere
```

This keeps Grantry differentiated as an agent IAM and SaaS credential gateway,
while preventing connector coverage from becoming the bottleneck.

## Non-goals

- Grantry is not a general internet HTTP proxy.
- Grantry does not bypass provider scopes, plan limits, or account permissions.
- Grantry does not expose raw credentials to agents.
- Grantry does not need to hand-curate every provider operation before a user
  can make progress.

## Product thesis

The goal is not "more HubSpot tools."

The goal is:

```
Any connected provider should be safely explorable and callable by an agent,
under Grantry's workspace, tenant, connection grant, policy, and audit model.
```

That is the path from connector list to product.
