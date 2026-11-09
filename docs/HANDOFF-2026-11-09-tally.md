# Tally provider - 2026-11-09

Adds API-key onboarding, 15 named operations and the existing generic request,
connection-check and capability tools. The connector reuses the current credential,
tenant-policy and HTTP transport layers. Official Tally OpenAPI was checked on
2026-11-09. No external account operations were performed by the tests.

Base: main commit `3f7a3d5a675e9d7d63e2186ce29339635ea8291f`, confirmed against
GitHub on 2026-11-09. No unrelated connector changes are included.

Validation: all 270 connection tests pass; TypeScript build, Prisma schema
validation with a dummy database URL and `git diff --check` pass. `npm run check`
passes scope, request/generic coverage and i18n audits, then fails because
`docs/gtm-evidence.md` is absent from the base repository. The audit is unchanged.
Internal historical evidence has not been republished to satisfy that audit.

This change is not yet production-validated. No live Tally credential was supplied.
After the required check prerequisite is resolved, run the complete check, deliver
the scoped change to main, verify deployment, and validate authorized Tally
onboarding and a read-only request. Keep source delivery, deployment and live
connection results separate.
