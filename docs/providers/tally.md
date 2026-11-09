# Tally

Connect using an API key from [Tally Settings → API keys](https://tally.so/settings/api-keys).
Select Tally in Grantry, save the key in the intended tenant, then grant only the required tools to the agent. The key inherits its owner's Tally permissions; adding this provider does not create a connection or grant access to any existing agent.

Grantry uses Bearer authentication against `https://api.tally.so`. The existing encrypted credential storage, tenant policy and request transport apply to both named tools and `tally/request`. Connection checks only read account information and small form, workspace and webhook listings. They do not create a form or submit a response.

| Tools | Arguments beyond the common tenant/connection arguments |
| --- | --- |
| `get_me` | None |
| `list_forms` | Optional `page`, `limit` (1–500), `workspace_ids` |
| `get_form`, `delete_form`, `list_questions` | `form_id` |
| `create_form` | `data` containing Tally's `blocks` and `status`; optional `workspaceId`, `templateId`, `folderId`, `settings` |
| `update_form` | `form_id`, `data` containing changes to `name`, `status`, `blocks` or `settings` |
| `list_submissions` | `form_id`; optional `page`, `limit` (1–500), `filter` (`all`, `completed`, `partial`), `start_date`, `end_date` (ISO 8601) |
| `get_submission`, `delete_submission` | `form_id`, `submission_id` |
| `list_workspaces` | Optional `page` |
| `list_webhooks` | Optional `page`, `limit` (1–100) |
| `create_webhook` | `data` containing `formId`, `url`, `eventTypes` (e.g. `["FORM_RESPONSE"]`) |
| `update_webhook` | `webhook_id`, `data` containing `url`, `eventTypes`, `isEnabled` |
| `delete_webhook` | `webhook_id` |

All named tools accept optional `api_version`, sent as `tally-version`. To use other documented endpoints, call `tally/request` with a relative path, method, optional query/body/headers. Never place the API key in tool arguments. Generic requests use `headers: {"tally-version": "<documented version>"}` when pinning a version.

List responses preserve Tally's pagination metadata; increment `page` according to the response until there are no more results. Reads do not automatically collect every page. Prefer webhooks for ongoing submission notifications; Tally documents a limit of 100 requests per minute.

Use `status: "DRAFT"` when creating a form that should remain unpublished. Setting `PUBLISHED` publishes it. Form deletion moves a form to trash. Submission deletion and webhook changes affect the live account. Existing tool grants and operator authorization still apply; this implementation does not perform any such live operation during testing.

This provider does not install One Academy → Twenty synchronization. That is a separate application integration. Tally's documented submission endpoints allow reading/deleting submissions; no undocumented response-creation endpoint is exposed as a named tool.

Sources checked 2026-11-09: [official OpenAPI](https://developers.tally.so/api-reference/openapi.json), [API keys](https://developers.tally.so/api-reference/api-keys), [API overview](https://tally.so/help/api).
