-- Read-only production inventory for docs/gtm-evidence.md.
-- Run with: railway connect Postgres < scripts/gtm-evidence-inventory.sql
--
-- This intentionally avoids credential, refresh token, request argument,
-- response body, user email, and IP columns. It is evidence triage, not an
-- export of customer data.

\pset pager off

SELECT
  c.provider,
  COUNT(*) AS enabled_connections,
  COUNT(DISTINCT c.scope) AS scopes,
  COUNT(DISTINCT c."workspaceId") AS workspaces
FROM connection c
WHERE c.enabled = true
  AND c.provider IN (
    'google_gsc',
    'google_analytics',
    'google_ads',
    'google_sheets',
    'slack',
    'gmail',
    'hubspot'
  )
GROUP BY c.provider
ORDER BY c.provider;

SELECT
  w.slug AS workspace_slug,
  w."displayName" AS workspace_display,
  t.slug AS scope,
  t."displayName" AS scope_display,
  c.provider,
  c."authType",
  c."healthStatusSnapshot",
  c."healthCheckedAtSnapshot",
  COUNT(DISTINCT acg."agentId") AS granted_agents,
  COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'ok') AS ok_audits,
  MAX(a."createdAt") FILTER (WHERE a.status = 'ok') AS latest_ok_at
FROM workspace w
JOIN tenant t ON t."workspaceId" = w.id
JOIN connection c ON c."tenantId" = t.id AND c.enabled = true
LEFT JOIN agent_connection_grant acg ON acg."connectionId" = c.id
LEFT JOIN audit_log a ON a."connectionId" = c.id
WHERE c.provider IN (
    'google_gsc',
    'google_analytics',
    'google_ads',
    'google_sheets',
    'slack',
    'gmail',
    'hubspot'
  )
  AND (
    w.slug ILIKE '%us%' OR w."displayName" ILIKE '%us%' OR
    w.slug ILIKE '%agency%' OR w."displayName" ILIKE '%agency%' OR
    t.slug ILIKE '%us%' OR t."displayName" ILIKE '%us%' OR
    t.slug ILIKE '%agency%' OR t."displayName" ILIKE '%agency%'
  )
GROUP BY
  w.slug,
  w."displayName",
  t.slug,
  t."displayName",
  c.provider,
  c."authType",
  c."healthStatusSnapshot",
  c."healthCheckedAtSnapshot"
ORDER BY latest_ok_at DESC NULLS LAST, granted_agents DESC, c.provider;

SELECT
  a."createdAt",
  a.scope,
  a.provider,
  a.tool,
  a.status,
  CASE
    WHEN a."errorMessage" IS NULL OR a."errorMessage" = '' THEN ''
    WHEN a."errorMessage" ILIKE '%policy denied%' THEN 'policy_denied'
    WHEN a."errorMessage" ILIKE '%auth%' OR a."errorMessage" ILIKE '%unauthorized%' THEN 'auth_error'
    WHEN a."errorMessage" ILIKE '%scope%' THEN 'provider_scope_error'
    WHEN a."errorMessage" ILIKE '%timeout%' THEN 'timeout'
    ELSE 'provider_or_tool_error'
  END AS error_class,
  a."durationMs"
FROM audit_log a
WHERE a.provider IN (
    'google_gsc',
    'google_analytics',
    'google_ads',
    'google_sheets',
    'slack',
    'gmail',
    'hubspot'
  )
ORDER BY a."createdAt" DESC
LIMIT 30;
