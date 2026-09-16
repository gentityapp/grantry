# Security Policy

## Supported versions

grantry deploys continuously from `main`. Security fixes land on the latest `main` and go live on the hosted service shortly after merge. We do not backport fixes to older releases.

| Channel | Supported |
| --- | --- |
| Latest `main` | Yes |
| Hosted service (`api.grantry.ai` / `app.grantry.ai`) | Yes |
| Older commits or pinned releases | No — run the latest `main` |

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security report.**

Report it privately through GitHub's private vulnerability reporting: open the repository's [Security tab](https://github.com/gentityapp/grantry/security) and choose **Report a vulnerability**.

Please include:

- The affected component or endpoint (URL, MCP tool name, or file).
- Step-by-step instructions, or a minimal proof of concept.
- The impact you believe it has, and who can exploit it.
- A suggested fix, if you have one (optional).

## What to expect

- We acknowledge every report within **3 business days**.
- We will keep you informed while we investigate and prepare a fix.
- Please keep the report confidential until a fix is released. We will credit you in the fix notes unless you ask to remain anonymous.
