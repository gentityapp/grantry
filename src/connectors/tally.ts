import type { ProviderDef } from "./registry.js";
import { callGenericProviderRequest } from "./generic_request.js";

// Endpoint and query names follow Tally's official OpenAPI specification.
// Share the provider transport so named tools retain the same host, credential,
// redirect, timeout and error handling as tally/request.
type Tool = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: boolean;
};

export const TALLY_TOOLS: Record<string, Tool> = {
  "tally/get_me": { method: "GET", path: "/users/me" },
  "tally/list_forms": { method: "GET", path: "/forms", query: { page: "page", limit: "limit", workspace_ids: "workspaceIds" } },
  "tally/get_form": { method: "GET", path: "/forms/{form_id}" },
  "tally/create_form": { method: "POST", path: "/forms", body: true },
  "tally/update_form": { method: "PATCH", path: "/forms/{form_id}", body: true },
  "tally/delete_form": { method: "DELETE", path: "/forms/{form_id}" },
  "tally/list_questions": { method: "GET", path: "/forms/{form_id}/questions" },
  "tally/list_submissions": { method: "GET", path: "/forms/{form_id}/submissions", query: { page: "page", limit: "limit", filter: "filter", start_date: "startDate", end_date: "endDate" } },
  "tally/get_submission": { method: "GET", path: "/forms/{form_id}/submissions/{submission_id}" },
  "tally/delete_submission": { method: "DELETE", path: "/forms/{form_id}/submissions/{submission_id}" },
  "tally/list_workspaces": { method: "GET", path: "/workspaces", query: { page: "page" } },
  "tally/list_webhooks": { method: "GET", path: "/webhooks", query: { page: "page", limit: "limit" } },
  "tally/create_webhook": { method: "POST", path: "/webhooks", body: true },
  "tally/update_webhook": { method: "PATCH", path: "/webhooks/{webhook_id}", body: true },
  "tally/delete_webhook": { method: "DELETE", path: "/webhooks/{webhook_id}" },
};

function ids(tool: Tool): string[] {
  return Array.from(tool.path.matchAll(/\{(\w+)\}/g), (match) => match[1]);
}

export function tallyRequiredArgs(toolName: string): string[] {
  const tool = TALLY_TOOLS[toolName];
  return tool ? [...ids(tool), ...(tool.body ? ["data"] : [])] : [];
}

export function tallyInputProperties(toolName: string): Record<string, unknown> {
  const tool = TALLY_TOOLS[toolName];
  if (!tool) return {};
  const properties: Record<string, unknown> = {
    api_version: { type: "string", description: "Optional Tally API version, sent in the tally-version header." },
  };
  for (const id of ids(tool)) properties[id] = { type: "string", minLength: 1, description: `Tally ${id.replace(/_/g, " ")}.` };
  for (const key of Object.keys(tool.query ?? {})) {
    properties[key] = key === "page" || key === "limit"
      ? { type: "integer", minimum: 1, ...(key === "limit" ? { maximum: toolName === "tally/list_webhooks" ? 100 : 500 } : {}) }
      : key === "workspace_ids"
        ? { type: "array", items: { type: "string" }, description: "Only forms in these workspaces." }
        : key === "filter"
          ? { type: "string", enum: ["all", "completed", "partial"] }
          : { type: "string", description: "ISO 8601 date-time." };
  }
  if (tool.body) properties.data = {
    type: "object",
    description: toolName === "tally/create_form"
      ? "Tally form body: blocks and status (BLANK, DRAFT or PUBLISHED) are required; workspaceId, templateId, folderId and settings are optional."
      : toolName === "tally/create_webhook"
        ? "Tally webhook body: formId, url and eventTypes (e.g. [FORM_RESPONSE]) are required."
        : toolName === "tally/update_webhook"
          ? "Tally webhook body: url, eventTypes and isEnabled are required."
          : "Tally form changes: name, status, blocks and/or settings. PUBLISHED publishes the form.",
  };
  return properties;
}

export async function callTallyTool(toolName: string, args: Record<string, unknown>, credential: string, provider: ProviderDef) {
  const tool = TALLY_TOOLS[toolName];
  if (!tool) throw new Error(`Unknown Tally tool: ${toolName}`);
  const path = tool.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
    return encodeURIComponent(value.trim());
  });
  if (tool.body && (!args.data || typeof args.data !== "object" || Array.isArray(args.data))) {
    throw new Error("data must be a JSON object");
  }
  const query: Record<string, unknown> = {};
  for (const [key, apiKey] of Object.entries(tool.query ?? {})) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (key === "page" || key === "limit") {
      const max = key === "limit" ? (toolName === "tally/list_webhooks" ? 100 : 500) : Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) throw new Error(`${key} is outside the Tally pagination range`);
    }
    if (key === "workspace_ids" && (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim()))) throw new Error("workspace_ids must be an array of workspace IDs");
    if (key === "filter" && !["all", "completed", "partial"].includes(String(value))) throw new Error("filter must be all, completed or partial");
    query[apiKey] = value;
  }
  if (args.api_version !== undefined && (typeof args.api_version !== "string" || !args.api_version.trim())) throw new Error("api_version must be a non-empty string");
  return callGenericProviderRequest({
    provider,
    toolName,
    credential,
    requestArgs: {
      method: tool.method,
      path,
      query,
      ...(tool.body ? { body: args.data } : {}),
      ...(args.api_version ? { headers: { "tally-version": args.api_version } } : {}),
    },
  });
}
