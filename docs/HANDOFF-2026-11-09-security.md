# Security boundary hardening — 2026-11-09

Base: main 3f7a3d5. This change does not include the Tally provider branch.

Startup no longer pushes database schemas or runs data/permission backfills. Legacy grant migration requires an explicit --apply, and never infers manager authority from names. Existing explicit grants and manager flags are not rewritten. Review historical grants and logs separately before making any incident-remediation claim.

Request audit masking is recursive; request payload containers and response bodies are not retained in audit summaries. Runtime error logs store classifications. HTTP request logs omit URLs. Browser origins are checked for session writes; bearer MCP/file endpoints retain cookieless cross-origin access. Uploaded files are attachments with sandbox and nosniff headers. Upload tickets enforce agent expiry and atomic usage. Delegation checks owner and workspace at mint/redemption, and consumes a grant atomically. Public GitHub binary downloads use HTTPS, public DNS validation pinned to the socket, bounded redirects/time/size. SSH address checks include IPv6 representations. Generic authenticated requests refuse redirects. OAuth inline script values escape less-than characters.

Dependencies were refreshed, but better-auth is pinned to 1.6.34: 1.7 removes the in-core MCP plugin and requires an OAuth schema/client migration. Do not upgrade that dependency without a reviewed migration and session-compatibility tests. npm audit reports 3 packages (1 critical, 2 low); the reported features are Magic Link, OAuth Proxy, device authorization, and Drizzle/Kysely adapters. This application configures only MCP and the Prisma adapter. The advisories and configuration were reviewed; this is not a blanket guarantee about authentication or future plugin changes.

The previously missing GTM ledger is restored as a public-source inventory with blocked evidence statuses. It makes no adoption claims and contains no private operational records; the audit itself is unchanged.

Validation: npm run check passed (provider/i18n/GTM audits, TypeScript, Prisma schema), all 270 connection tests passed, git diff --check passed. All 9 focused boundary tests also passed after the final redaction review. Browser verification must be recorded separately; Hono request tests alone are not browser proof. Production verification must remain separate from these local checks. No database, stored grants, historical audit rows, user credentials or real provider data were mutated by tests.

Deployment follow-up: verify the deployed revision, trusted origins, same-origin dashboard access, MCP discovery and an authorized read. Verify the first boot does not invoke migrations. Existing boot-time backfills are now explicit maintenance tasks; new installations must provision their schema before startup.
