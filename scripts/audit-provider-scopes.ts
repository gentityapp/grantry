import { PROVIDERS } from "../src/connectors/registry.js";

const WRITE_TOOL_PATTERN = /\/(?:create|update|delete|publish|send|mutate|append|reply|post|submit|vote|add|remove|invite|open|purge|git_push|transition)_?/;
const IDENTITY_SCOPES = new Set([
  "openid",
  "profile",
  "email",
  "read:user",
  "userinfo.email",
  "https://www.googleapis.com/auth/userinfo.email",
  "identity",
  "users.read",
  "user:read:user",
  "user:read:list_users:admin",
]);

function uniq(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function operationScopes(providerKey: string, tool: string) {
  const provider = PROVIDERS[providerKey];
  const required = new Set<string>();
  for (const op of provider.genericRequest?.operations ?? []) {
    if ((op.tools ?? []).includes(tool)) {
      for (const scope of op.requiredScopes ?? []) required.add(scope);
    }
  }
  return Array.from(required);
}

function requiredScopes(providerKey: string, tool: string) {
  const provider = PROVIDERS[providerKey];
  return uniq([
    ...(provider.toolScopeRequirements?.[tool] ?? []),
    ...operationScopes(providerKey, tool),
  ]);
}

function isWriteTool(tool: string) {
  return WRITE_TOOL_PATTERN.test(tool);
}

const errors: string[] = [];

for (const provider of Object.values(PROVIDERS)) {
  if (provider.implemented === false) continue;
  const tools = new Set(provider.tools);
  const hasScopedAuth = provider.authTypes.includes("oauth") || provider.authTypes.includes("service_account");

  for (const [tool, scopes] of Object.entries(provider.toolScopeRequirements ?? {})) {
    if (!tools.has(tool)) errors.push(`${provider.key}: toolScopeRequirements references unknown tool ${tool}`);
    if (!scopes.length) errors.push(`${provider.key}: ${tool} has empty toolScopeRequirements`);
  }

  for (const op of provider.genericRequest?.operations ?? []) {
    for (const tool of op.tools ?? []) {
      if (!tools.has(tool)) errors.push(`${provider.key}: generic operation ${op.id} references unknown tool ${tool}`);
    }
    if ((op.risk === "write" || op.risk === "destructive") && hasScopedAuth && !(op.requiredScopes ?? []).length) {
      errors.push(`${provider.key}: generic ${op.risk} operation ${op.id} is missing requiredScopes`);
    }
  }

  if (!hasScopedAuth) continue;

  const oauthScopes = new Set(provider.oauthScopes ?? []);
  const optionalOauthScopes = new Set(provider.oauthOptionalScopes ?? []);
  const dwdScopes = new Set(provider.dwdScopes ?? []);

  for (const tool of provider.tools) {
    const scopes = requiredScopes(provider.key, tool);
    if (isWriteTool(tool) && scopes.length === 0) {
      errors.push(`${provider.key}: write-like tool ${tool} is missing provider required scopes`);
      continue;
    }

    for (const scope of scopes) {
      if (provider.authTypes.includes("oauth") && !oauthScopes.has(scope) && !optionalOauthScopes.has(scope)) {
        errors.push(`${provider.key}: ${tool} requires ${scope}, but oauthScopes/oauthOptionalScopes do not request it`);
      }
      if (provider.authTypes.includes("service_account") && !dwdScopes.has(scope) && !IDENTITY_SCOPES.has(scope)) {
        errors.push(`${provider.key}: ${tool} requires ${scope}, but dwdScopes do not include it`);
      }
    }
  }
}

if (errors.length) {
  console.error("Provider scope audit failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Provider scope audit passed");
