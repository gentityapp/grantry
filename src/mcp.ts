// MCP JSON-RPC gateway with auth + policy + dispatch
// Phase 2: implements real tool dispatch for notion/* and github/*
// Phase 3: scope-based policy enforcement
import { Hono } from "hono";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { prisma } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { checkPolicy, connectionsForAgent, delegatableToolsForAgent, findCapableAgents, guessToolsFromTask, normalizeToolName } from "./policy.js";
import { PROVIDERS, getProviderForWorkspace, listProvidersForWorkspace } from "./connectors/registry.js";
import { callNotionTool } from "./connectors/notion.js";
import { callGitHubTool } from "./connectors/github.js";
import { callCloudflareTool } from "./connectors/cloudflare.js";
import { callClarityTool } from "./connectors/clarity.js";
import { callGoogleDriveTool } from "./connectors/google_drive.js";
import { callGoogleGscTool } from "./connectors/google_gsc.js";
import { callGoogleAnalyticsTool } from "./connectors/google_analytics.js";
import { callGoogleAdsTool } from "./connectors/google_ads.js";
import { callGoogleMapsTool } from "./connectors/google_maps.js";
import { callYahooAdsTool } from "./connectors/yahoo_ads.js";
import { callMetaAdsTool } from "./connectors/meta_ads.js";
import { callHubSpotTool } from "./connectors/hubspot.js";
import { callGmailTool } from "./connectors/gmail.js";
import { callYouTubeTool } from "./connectors/youtube.js";
import { callAttioTool } from "./connectors/attio.js";
import { callClayTool } from "./connectors/clay.js";
import { callHeyReachTool } from "./connectors/heyreach.js";
import { callChatworkTool } from "./connectors/chatwork.js";
import { callRailwayTool } from "./connectors/railway.js";
import { callResendTool } from "./connectors/resend.js";
import { callSlackTool } from "./connectors/slack.js";
import { callFreeeTool } from "./connectors/freee.js";
import { callMoneyForwardTool } from "./connectors/moneyforward.js";
import { callRedditTool } from "./connectors/reddit.js";
import { callZoomTool } from "./connectors/zoom.js";
import { callXTool } from "./connectors/x.js";
import { callDiscordTool } from "./connectors/discord.js";
import { callLineTool } from "./connectors/line.js";
import { callFacebookMessengerTool } from "./connectors/facebook_messenger.js";
import { callAirtableTool } from "./connectors/airtable.js";
import { callLinearTool } from "./connectors/linear.js";
import { callSendGridTool } from "./connectors/sendgrid.js";
import { callVercelTool } from "./connectors/vercel.js";
import { callStripeTool } from "./connectors/stripe.js";
import { callWebflowTool } from "./connectors/webflow.js";
import { callIntercomTool } from "./connectors/intercom.js";
import { callCustomerioTool } from "./connectors/customerio.js";
import { callMailchimpTool } from "./connectors/mailchimp.js";
import { callZendeskTool } from "./connectors/zendesk.js";
import { callWordpressTool } from "./connectors/wordpress.js";
import { callShopifyTool } from "./connectors/shopify.js";
import { callJiraTool } from "./connectors/jira.js";
import { callSalesforceTool } from "./connectors/salesforce.js";
import { callLinkedinAdsTool } from "./connectors/linkedin_ads.js";
import { callTiktokAdsTool } from "./connectors/tiktok_ads.js";
import { callMicrosoftAdsTool } from "./connectors/microsoft_ads.js";
import { callAwsTool } from "./connectors/aws.js";
import { callSnowflakeTool } from "./connectors/snowflake.js";
import { callGoogleCalendarTool } from "./connectors/google_calendar.js";
import { callGoogleSheetsTool } from "./connectors/google_sheets.js";
import { callGoogleTagManagerTool } from "./connectors/google_tag_manager.js";
import { callGoogleCloudTool } from "./connectors/google_cloud.js";
import { callBigQueryTool } from "./connectors/bigquery.js";
import { callGoogleAdminTool } from "./connectors/google_admin.js";
import { credentialMetadataForStorage } from "./connectors/credential_meta.js";
import { mintDwdAccessToken, type ServiceAccountCredential } from "./google_dwd.js";
import { callGenericCheckConnection, callGenericListCapabilities, callGenericProviderRequest } from "./connectors/generic_request.js";
import { userMayUseAgent } from "./workspaces.js";

export const mcpApp = new Hono();

const TOKEN_REFRESH_TIMEOUT_MS = 8_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MCP_SESSION_TTL_MS = 60 * 60 * 1000;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const SKILL_URL = new URL("../docs/skill.md", import.meta.url);

const SYSTEM_TOOLS = [
  "grantry/get_skill",
  "grantry/get_providers",
  "grantry/list_scopes",
  "grantry/find_agent",
  "grantry/route",
  "grantry/delegate",
] as const;

// System tools that need the calling agent's identity (workspace boundary) and
// therefore require authentication, unlike the public metadata tools.
const AUTHED_SYSTEM_TOOLS = new Set<string>(["grantry/list_scopes", "grantry/find_agent", "grantry/route", "grantry/delegate"]);

// Capability-scoped delegation TTL: short by design (single-use anyway).
const DELEGATION_TTL_MS = 5 * 60 * 1000;

type McpSession = {
  agentId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
};

const mcpSessions = new Map<string, McpSession>();

function cleanupExpiredMcpSessions() {
  const now = Date.now();
  for (const [id, session] of mcpSessions) {
    if (session.expiresAt <= now) mcpSessions.delete(id);
  }
}

function configuredMcpScope(c: any): string {
  // URL path lock (/mcp/s/<scope>) wins; falls back to headers for clients
  // that can set them (CLI configs). claude.ai can only vary the URL.
  const pathScope = String(c.req.param?.("scope") ?? "").trim();
  if (pathScope) return pathScope;
  return String(
    c.req.header("x-grantry-scope") ?? c.req.header("x-grantry-tenant") ??
    c.req.header("x-gentity-scope") ?? c.req.header("x-gentity-tenant") ?? ""
  ).trim();
}

function publicToolName(canonicalName: string): string {
  return canonicalName === "ping" ? canonicalName : canonicalName.replace("/", "_");
}

function canonicalToolName(name: unknown): string {
  const raw = String(name ?? "");
  if (raw === "ping") return raw;
  // Legacy aliases: system tools were renamed gentity/* -> grantry/* (2026-06).
  // Keep accepting the old names (canonical "/" form and public "_" form) so
  // existing agent configs never break.
  if (raw === "gentity/get_skill" || raw === "gentity_get_skill") return "grantry/get_skill";
  if (raw === "gentity/get_providers" || raw === "gentity_get_providers") return "grantry/get_providers";
  for (const tool of SYSTEM_TOOLS) {
    if (raw === tool || raw === publicToolName(tool)) return tool;
  }
  for (const provider of Object.values(PROVIDERS)) {
    if (provider.tools.includes(raw)) return raw;
    const matched = provider.tools.find((tool) => publicToolName(tool) === raw);
    if (matched) return matched;
  }
  return raw;
}

function toolSpecificInputProperties(toolName: string): Record<string, any> {
  if (toolName === "grantry/get_skill") {
    return {
      format: { type: "string", enum: ["markdown"], description: "Output format. Defaults to markdown." },
    };
  }
  if (toolName === "grantry/get_providers") {
    return {
      include_tools: { type: "boolean", description: "When true, include each provider's tool names. Defaults to true." },
    };
  }
  if (toolName === "grantry/list_scopes") {
    return {};
  }
  if (toolName === "grantry/find_agent") {
    return {
      task: { type: "string", description: "Plain-language description of what you want to do, e.g. 'set an env var on the prod Railway project'." },
      scope: { type: "string", description: "Optional tenant scope to restrict the search to." },
    };
  }
  if (toolName === "grantry/route") {
    return {
      tool: { type: "string", description: "Canonical tool name to route, e.g. 'railway/graphql' (the public 'railway_graphql' form is also accepted)." },
      scope: { type: "string", description: "Optional tenant scope the tool must target." },
      action: { type: "string", enum: ["read", "write"], description: "Optional intent hint. Advisory only — not yet used to filter results." },
    };
  }
  if (toolName === "grantry/delegate") {
    return {
      agent_id: { type: "string", description: "Id of the capable agent to delegate to (from grantry_find_agent / grantry_route). Must share your owner." },
      tool: { type: "string", description: "Canonical tool to authorize, e.g. 'railway/graphql' (public 'railway_graphql' also accepted)." },
      scope: { type: "string", description: "Tenant scope the grant is for." },
    };
  }
  // --- github ---
  if (toolName === "github/get_file_contents") {
    return {
      owner: { type: "string", description: "Repository owner (user or org)." },
      repo: { type: "string", description: "Repository name." },
      path: { type: "string", description: "File or directory path. Empty string ('') reads the repo root as a directory listing." },
      ref: { type: "string", description: "Optional branch, tag, or commit SHA to read from." },
    };
  }
  if (toolName === "github/get_repo") {
    return {
      owner: { type: "string", description: "Repository owner (user or org)." },
      repo: { type: "string", description: "Repository name." },
    };
  }
  if (toolName === "github/list_issues") {
    return {
      owner: { type: "string", description: "Repository owner (user or org)." },
      repo: { type: "string", description: "Repository name." },
      state: { type: "string", enum: ["open", "closed", "all"], description: "Issue state filter. Defaults to open." },
    };
  }
  if (toolName === "github/create_issue") {
    return {
      owner: { type: "string", description: "Repository owner (user or org)." },
      repo: { type: "string", description: "Repository name." },
      title: { type: "string", description: "Issue title." },
      body: { type: "string", description: "Optional issue body (Markdown)." },
    };
  }
  if (toolName === "github/git_push_repo") {
    return {
      owner: { type: "string", description: "Repository owner (user or org)." },
      repo: { type: "string", description: "Repository name." },
      branch: { type: "string", description: "Target branch. Defaults to main. Created if it does not exist." },
      commit_message: { type: "string", description: "Commit message. Defaults to 'chore: update via grantry'." },
      files: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Map of repository file path to UTF-8 text content, e.g. { \"README.md\": \"# Title\", \"src/app.ts\": \"...\" }. All files land in a single commit.",
      },
    };
  }
  if (toolName === "github/create_repo") {
    return {
      name: { type: "string", description: "New repository name." },
      org: { type: "string", description: "Optional org to create the repo under. Omit to create under the authenticated user." },
      description: { type: "string", description: "Optional repository description." },
      private: { type: "boolean", description: "Whether the repo is private. Defaults to false." },
    };
  }
  if (toolName === "notion/get_page") {
    return {
      page_id: { type: "string", description: "Notion page ID." },
      include_children: { type: "boolean", description: "When true, include the page's first-level block children." },
    };
  }
  if (toolName === "notion/query_db") {
    return {
      database_id: { type: "string", description: "Notion database ID." },
      filter: { type: "object", description: "Optional Notion database query filter object." },
      sorts: { type: "array", items: { type: "object" }, description: "Optional Notion database query sorts array." },
      page_size: { type: "number", minimum: 1, maximum: 100, description: "Rows to return, max 100." },
      start_cursor: { type: "string", description: "Pagination cursor returned as next_cursor." },
      slug: { type: "string", description: "Optional shortcut filter for a slug rich_text property." },
      slug_property: { type: "string", description: "Slug property name, default Slug." },
    };
  }
  if (toolName === "notion/create_page") {
    return {
      parent: { type: "object", description: "Notion page parent object." },
      properties: { type: "object", description: "Raw Notion properties object." },
    };
  }
  if (toolName === "notion/update_page") {
    return {
      page_id: { type: "string", description: "Notion page ID." },
      properties: { type: "object", description: "Raw Notion properties object to PATCH onto the page." },
      archived: { type: "boolean", description: "Archive or restore the page." },
      icon: { type: "object", description: "Optional raw Notion icon object." },
      cover: { type: "object", description: "Optional raw Notion cover object." },
    };
  }
  if (toolName === "notion/append_blocks") {
    return {
      page_id: { type: "string", description: "Page ID to append children to. Alias for parent_block_id." },
      parent_block_id: { type: "string", description: "Block ID whose children should receive appended blocks." },
      after: { type: "string", description: "Optional sibling block ID to insert after." },
      children: { type: "array", items: { type: "object" }, description: "Raw Notion block children array." },
    };
  }
  if (toolName === "notion/update_blocks") {
    return {
      operations: {
        type: "array",
        maxItems: 25,
        items: {
          type: "object",
          properties: {
            block_id: { type: "string" },
            patch: { type: "object", description: "Raw Notion block PATCH body." },
            archived: { type: "boolean", description: "Shortcut to archive or restore a block." },
          },
          required: ["block_id"],
        },
        description: "Batch of block PATCH operations. Each item needs block_id and either patch or archived.",
      },
    };
  }
  if (toolName === "notion/update_page_status") {
    return {
      page_id: { type: "string", description: "Notion page ID." },
      status: { type: "string", description: "Status property name." },
      status_name: { type: "string", description: "New status option name, default Done." },
    };
  }
  if (toolName === "cloudflare/list_zones") {
    return {
      name: { type: "string", description: "Optional exact zone name filter, e.g. example.com." },
      page: { type: "number", minimum: 1, description: "Page number." },
      per_page: { type: "number", minimum: 1, maximum: 100, description: "Zones per page." },
    };
  }
  if (toolName === "cloudflare/get_zone") {
    return {
      zone_id: { type: "string", description: "Cloudflare zone id." },
    };
  }
  if (toolName === "cloudflare/list_dns_records") {
    return {
      zone_id: { type: "string", description: "Cloudflare zone id." },
      type: { type: "string", description: "Optional DNS record type, e.g. A, CNAME, TXT." },
      name: { type: "string", description: "Optional DNS record name." },
      content: { type: "string", description: "Optional DNS record content." },
      page: { type: "number", minimum: 1, description: "Page number." },
      per_page: { type: "number", minimum: 1, maximum: 500, description: "Records per page." },
    };
  }
  if (toolName === "cloudflare/create_dns_record") {
    return {
      zone_id: { type: "string", description: "Cloudflare zone id." },
      type: { type: "string", description: "DNS record type, e.g. A, CNAME, TXT." },
      name: { type: "string", description: "DNS record name." },
      content: { type: "string", description: "DNS record content." },
      ttl: { type: "number", description: "TTL in seconds. Use 1 for automatic." },
      proxied: { type: "boolean", description: "Whether the record is proxied by Cloudflare." },
      priority: { type: "number", description: "Priority for MX/SRV records." },
      comment: { type: "string", description: "Optional record comment." },
      tags: { type: "array", items: { type: "string" }, description: "Optional record tags." },
    };
  }
  if (toolName === "cloudflare/update_dns_record") {
    return {
      zone_id: { type: "string", description: "Cloudflare zone id." },
      record_id: { type: "string", description: "Cloudflare DNS record id." },
      type: { type: "string", description: "DNS record type." },
      name: { type: "string", description: "DNS record name." },
      content: { type: "string", description: "DNS record content." },
      ttl: { type: "number", description: "TTL in seconds. Use 1 for automatic." },
      proxied: { type: "boolean", description: "Whether the record is proxied by Cloudflare." },
      priority: { type: "number", description: "Priority for MX/SRV records." },
      comment: { type: "string", description: "Optional record comment." },
      tags: { type: "array", items: { type: "string" }, description: "Optional record tags." },
    };
  }
  if (toolName === "cloudflare/delete_dns_record") {
    return {
      zone_id: { type: "string", description: "Cloudflare zone id." },
      record_id: { type: "string", description: "Cloudflare DNS record id." },
    };
  }
  if (toolName === "cloudflare/purge_cache") {
    return {
      zone_id: { type: "string", description: "Cloudflare zone id." },
      purge_everything: { type: "boolean", description: "Purge the entire zone cache." },
      files: { type: "array", items: { type: "string" }, description: "Specific URLs to purge." },
      tags: { type: "array", items: { type: "string" }, description: "Cache tags to purge." },
      hosts: { type: "array", items: { type: "string" }, description: "Hosts to purge." },
      prefixes: { type: "array", items: { type: "string" }, description: "URL prefixes to purge." },
    };
  }
  if (toolName === "clarity/get_live_insights") {
    return {
      num_of_days: { type: "number", enum: [1, 2, 3], description: "Number of recent days to export: 1, 2, or 3." },
      dimensions: {
        type: "array",
        maxItems: 3,
        items: { type: "string", enum: ["Browser", "Device", "Country", "OS", "Source", "Medium", "Campaign", "Channel", "URL"] },
        description: "Up to three dimensions to break down insights by.",
      },
      dimension1: { type: "string", enum: ["Browser", "Device", "Country", "OS", "Source", "Medium", "Campaign", "Channel", "URL"] },
      dimension2: { type: "string", enum: ["Browser", "Device", "Country", "OS", "Source", "Medium", "Campaign", "Channel", "URL"] },
      dimension3: { type: "string", enum: ["Browser", "Device", "Country", "OS", "Source", "Medium", "Campaign", "Channel", "URL"] },
    };
  }
  if (toolName === "google_drive/list_files" || toolName === "google_drive/search") {
    return {
      q: { type: "string", description: "Google Drive query string, e.g. name contains 'report' and trashed = false." },
      page_size: { type: "number", minimum: 1, maximum: 1000, description: "Files to return, max 1000." },
      page_token: { type: "string", description: "Optional pagination token." },
      order_by: { type: "string", description: "Optional Drive orderBy, e.g. modifiedTime desc." },
      corpora: { type: "string", description: "Optional corpus, e.g. user, drive, allDrives." },
      drive_id: { type: "string", description: "Shared drive id when corpora=drive." },
      fields: { type: "string", description: "Optional Drive partial-response fields selector." },
    };
  }
  if (toolName === "google_drive/get_file") {
    return {
      file_id: { type: "string", description: "Google Drive file id." },
      fields: { type: "string", description: "Optional metadata fields selector." },
      download: { type: "boolean", description: "When true, fetch binary file content as base64 for non-Google Workspace files." },
      alt: { type: "string", enum: ["media"], description: "Set to media to download binary content." },
      export_mime_type: {
        type: "string",
        description: "Export MIME type for Google Docs/Sheets/Slides, e.g. text/plain, text/csv, application/pdf.",
      },
    };
  }
  if (toolName === "google_gsc/list_sites") {
    return {};
  }
  if (toolName === "google_gsc/search_analytics") {
    return {
      site_url: {
        type: "string",
        description: "Exact Search Console property URL from google_gsc_list_sites, e.g. https://example.com/ or sc-domain:example.com.",
      },
      start_date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Start date in YYYY-MM-DD.",
      },
      end_date: {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "End date in YYYY-MM-DD.",
      },
      dimensions: {
        type: "array",
        items: { type: "string", enum: ["query", "page", "country", "device", "date", "searchAppearance"] },
        description: "Aggregation dimensions. Defaults to query,page.",
      },
      row_limit: {
        type: "number",
        minimum: 1,
        maximum: 25000,
        description: "Rows to return. Defaults to 1000.",
      },
      start_row: {
        type: "number",
        minimum: 0,
        description: "Pagination offset.",
      },
      search_type: {
        type: "string",
        enum: ["web", "image", "video", "news", "googleNews", "discover"],
        description: "Search type, default web.",
      },
      aggregation_type: {
        type: "string",
        enum: ["auto", "byPage", "byProperty"],
        description: "Search Console aggregation type.",
      },
      filters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            dimension: { type: "string", enum: ["query", "page", "country", "device", "date", "searchAppearance"] },
            operator: {
              type: "string",
              enum: ["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"],
            },
            expression: { type: "string" },
          },
          required: ["dimension", "operator", "expression"],
        },
        description: "Convenience filters converted into one dimensionFilterGroups entry with groupType=and.",
      },
      dimension_filter_groups: {
        type: "array",
        items: { type: "object" },
        description: "Raw Search Console dimensionFilterGroups array. Overrides filters when supplied.",
      },
    };
  }
  if (toolName === "google_analytics/list_properties") {
    return {
      page_size: { type: "number", minimum: 1, maximum: 200, description: "Account summaries page size, max 200." },
      page_token: { type: "string", description: "Optional pagination token." },
    };
  }
  if (toolName === "google_analytics/run_report") {
    return {
      property_id: { type: "string", description: "GA4 property id, either 123456 or properties/123456." },
      start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Start date in YYYY-MM-DD." },
      end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "End date in YYYY-MM-DD." },
      dimensions: { type: "array", items: { type: "string" }, description: "GA4 dimension names, e.g. date, sessionDefaultChannelGroup, pagePath." },
      metrics: { type: "array", items: { type: "string" }, description: "GA4 metric names, e.g. activeUsers, sessions, conversions." },
      limit: { type: "number", minimum: 1, maximum: 250000, description: "Rows to return. Defaults to 1000." },
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
      dimension_filter: { type: "object", description: "Raw GA4 Data API dimensionFilter expression." },
      metric_filter: { type: "object", description: "Raw GA4 Data API metricFilter expression." },
      order_bys: { type: "array", items: { type: "object" }, description: "Raw GA4 Data API orderBys array." },
      keep_empty_rows: { type: "boolean", description: "Whether to return rows with all metrics equal to zero." },
    };
  }
  if (toolName === "google_ads/list_accessible_customers") {
    return {
      login_customer_id: { type: "string", description: "Optional Google Ads manager customer id, no dashes." },
    };
  }
  if (toolName === "google_ads/search") {
    return {
      customer_id: { type: "string", description: "Google Ads customer id to query, with or without dashes." },
      query: { type: "string", description: "GAQL query string." },
      login_customer_id: { type: "string", description: "Optional manager customer id for login-customer-id header, no dashes." },
      page_size: { type: "number", minimum: 1, maximum: 10000, description: "Rows per page." },
      page_token: { type: "string", description: "Optional next page token." },
    };
  }
  if (toolName === "google_ads/mutate") {
    return {
      customer_id: { type: "string", description: "Google Ads customer id to mutate, with or without dashes." },
      operations: {
        type: "array",
        minItems: 1,
        items: { type: "object" },
        description: "Google Ads mutateOperations array, e.g. campaignBudgetOperation, campaignOperation, adGroupOperation, adGroupAdOperation, or adGroupCriterionOperation.",
      },
      login_customer_id: { type: "string", description: "Optional manager customer id for login-customer-id header, no dashes." },
      partial_failure: { type: "boolean", description: "When true, valid operations may still succeed if other operations fail." },
      validate_only: { type: "boolean", description: "When true, Google Ads validates the operations without applying changes." },
      response_content_type: { type: "string", enum: ["MUTABLE_RESOURCE", "RESOURCE_NAME_ONLY"], description: "Google Ads response content type." },
    };
  }
  if (toolName === "yahoo_ads/list_base_accounts") {
    return {
      product: { type: "string", enum: ["search", "display"], description: "Yahoo Ads product. Defaults to search." },
      selector: { type: "object", description: "Optional raw BaseAccountService selector." },
    };
  }
  if (toolName === "yahoo_ads/get") {
    return {
      product: { type: "string", enum: ["search", "display"], description: "Yahoo Ads product. Defaults to search." },
      base_account_id: { type: "string", description: "Base account id for x-z-base-account-id header. Not required for BaseAccountService." },
      service: { type: "string", description: "Service name, e.g. CampaignService, AccountService, AdGroupService." },
      method: { type: "string", enum: ["get"], description: "Read method. Defaults to get." },
      selector: { type: "object", description: "Raw selector object for the service." },
      body: { type: "object", description: "Alias for selector." },
    };
  }
  if (toolName === "yahoo_ads/mutate") {
    return {
      product: { type: "string", enum: ["search", "display"], description: "Yahoo Ads product. Defaults to search." },
      base_account_id: { type: "string", description: "Base account id for x-z-base-account-id header." },
      service: { type: "string", description: "Service name, e.g. CampaignService, AdGroupService, AdGroupAdService." },
      method: { type: "string", enum: ["add", "set", "remove", "upload"], description: "Mutation method." },
      operation: { type: "object", description: "Raw operation object for the service." },
      body: { type: "object", description: "Alias for operation." },
    };
  }
  if (toolName === "meta_ads/list_ad_accounts") {
    return {
      fields: { type: "string", description: "Comma-separated ad account fields. Defaults to id,account_id,name,account_status,currency,timezone_name." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Accounts to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (toolName === "meta_ads/get_ad_account") {
    return {
      account_id: { type: "string", description: "Meta ad account id, with or without the act_ prefix." },
      fields: { type: "string", description: "Comma-separated fields to include." },
    };
  }
  if (toolName === "meta_ads/list_campaigns") {
    return {
      account_id: { type: "string", description: "Meta ad account id, with or without the act_ prefix." },
      fields: { type: "string", description: "Comma-separated campaign fields." },
      effective_status: { type: "string", description: "Optional JSON array string to filter, e.g. [\"ACTIVE\",\"PAUSED\"]." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Campaigns to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (toolName === "meta_ads/get_campaign") {
    return {
      campaign_id: { type: "string", description: "Meta campaign id." },
      fields: { type: "string", description: "Comma-separated fields to include." },
    };
  }
  if (toolName === "meta_ads/list_ad_sets") {
    return {
      account_id: { type: "string", description: "Meta ad account id (used when campaign_id is omitted)." },
      campaign_id: { type: "string", description: "Optional campaign id to list its ad sets." },
      fields: { type: "string", description: "Comma-separated ad set fields." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Ad sets to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (toolName === "meta_ads/list_ads") {
    return {
      account_id: { type: "string", description: "Meta ad account id (used when campaign_id/adset_id are omitted)." },
      campaign_id: { type: "string", description: "Optional campaign id." },
      adset_id: { type: "string", description: "Optional ad set id." },
      fields: { type: "string", description: "Comma-separated ad fields." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Ads to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (toolName === "meta_ads/get_insights") {
    return {
      object_id: { type: "string", description: "Object to report on: ad account (act_…), campaign, ad set, or ad id." },
      account_id: { type: "string", description: "Ad account id, used when object_id is omitted." },
      fields: { type: "string", description: "Comma-separated insight metrics. Defaults to impressions,clicks,spend,cpc,cpm,ctr,reach,actions." },
      level: { type: "string", enum: ["account", "campaign", "adset", "ad"], description: "Aggregation level." },
      date_preset: { type: "string", description: "Date preset, e.g. today, yesterday, last_7d, last_30d. Ignored when time_range is set." },
      time_range: { type: "object", description: "Explicit range, e.g. { since: \"2026-01-01\", until: \"2026-01-31\" }." },
      breakdowns: { type: "string", description: "Comma-separated breakdowns, e.g. age,gender." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Rows to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (toolName === "meta_ads/create_campaign") {
    return {
      account_id: { type: "string", description: "Meta ad account id, with or without the act_ prefix." },
      campaign: { type: "object", description: "Campaign object, e.g. { name, objective, status, special_ad_categories }." },
    };
  }
  if (toolName === "meta_ads/update_campaign") {
    return {
      campaign_id: { type: "string", description: "Meta campaign id to update." },
      updates: { type: "object", description: "Fields to update, e.g. { name, status, daily_budget }." },
    };
  }
  if (toolName === "hubspot/list_deals") {
    return {
      limit: { type: "number", minimum: 1, maximum: 100, description: "Deals to return, max 100." },
      after: { type: "string", description: "HubSpot paging cursor." },
      properties: { type: "array", items: { type: "string" }, description: "Deal properties to include." },
    };
  }
  if (toolName === "hubspot/get_contact") {
    return {
      contact_id: { type: "string", description: "HubSpot contact object id." },
      properties: { type: "array", items: { type: "string" }, description: "Contact properties to include." },
    };
  }
  if (toolName === "hubspot/create_deal") {
    return {
      properties: { type: "object", description: "HubSpot deal properties, e.g. dealname, amount, pipeline, dealstage, closedate." },
    };
  }
  if (toolName === "hubspot/update_marketing_email") {
    return {
      email_id: { type: "string", description: "HubSpot marketing email id." },
      confirm: { type: "boolean", description: "Must be true. Required to update a HubSpot marketing email." },
      data: { type: "object", description: "Raw HubSpot PATCH body. Use this for exact HubSpot fields." },
      name: { type: "string", description: "Optional email internal name." },
      subject: { type: "string", description: "Optional email subject." },
      preview_text: { type: "string", description: "Optional preview text." },
      html: { type: "string", description: "Optional HTML/body field when supported by the HubSpot email type." },
      content: { type: "object", description: "Optional HubSpot content object." },
      from: { type: "object", description: "Optional sender object, e.g. { fromName, replyTo }." },
    };
  }
  if (toolName === "hubspot/publish_marketing_email") {
    return {
      email_id: { type: "string", description: "HubSpot marketing email id." },
      confirm: { type: "boolean", description: "Must be true. Required to publish a HubSpot marketing email." },
      data: { type: "object", description: "Optional raw HubSpot publish body." },
    };
  }
  if (toolName.endsWith("/request")) {
    return {
      path: { type: "string", description: "Provider API path relative to the provider base URL. Full URLs are rejected." },
      method: { type: "string", enum: ["GET"], description: "HTTP method. Phase 1 generic requests are read-only and allow GET only." },
      query: { type: "object", description: "Optional query parameters. Array values are repeated." },
    };
  }
  if (toolName.endsWith("/check_connection")) {
    return {};
  }
  if (toolName.endsWith("/list_capabilities")) {
    return {};
  }
  if (toolName === "attio/search_records") {
    return {
      query: { type: "string", maxLength: 256, description: "Fuzzy search query. An empty string returns Attio's default result set." },
      objects: { type: "array", minItems: 1, items: { type: "string" }, description: "Attio object slugs or IDs to search, e.g. people, companies, deals." },
      request_as: { type: "object", description: "Optional Attio request_as context. Defaults to { type: 'workspace' }." },
      limit: { type: "number", minimum: 1, maximum: 25, description: "Results to return, max 25." },
    };
  }
  if (toolName === "attio/list_records") {
    return {
      object: { type: "string", description: "Attio object slug or ID, e.g. people, companies, deals." },
      filter: { type: "object", description: "Optional Attio record query filter." },
      filter_view_id: { type: "string", description: "Optional Attio saved view UUID. Cannot be used with filter." },
      sorts: { type: "array", items: { type: "object" }, description: "Optional Attio record query sort array." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Records to return, max 500." },
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
    };
  }
  if (toolName === "attio/get_record") {
    return {
      object: { type: "string", description: "Attio object slug or ID, e.g. people, companies, deals." },
      record_id: { type: "string", description: "Attio record ID." },
    };
  }
  if (toolName === "attio/create_record") {
    return {
      object: { type: "string", description: "Attio object slug or ID, e.g. people, companies, deals." },
      values: { type: "object", description: "Attio record values keyed by attribute slug or ID." },
    };
  }
  if (toolName === "attio/upsert_record") {
    return {
      object: { type: "string", description: "Attio object slug or ID, e.g. people, companies, deals." },
      matching_attribute: { type: "string", description: "Unique Attio attribute slug or ID to match on, e.g. email_addresses or domains." },
      values: { type: "object", description: "Attio record values keyed by attribute slug or ID." },
    };
  }
  if (toolName === "attio/update_record") {
    return {
      object: { type: "string", description: "Attio object slug or ID, e.g. people, companies, deals." },
      record_id: { type: "string", description: "Attio record ID." },
      values: { type: "object", description: "Attio record values to append/update, keyed by attribute slug or ID." },
    };
  }
  if (toolName === "attio/list_notes") {
    return {
      parent_object: { type: "string", description: "Optional Attio parent object slug or ID, e.g. people." },
      parent_record_id: { type: "string", description: "Optional parent record ID. Use with parent_object." },
      limit: { type: "number", minimum: 1, maximum: 50, description: "Notes to return, max 50." },
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
    };
  }
  if (toolName === "attio/get_note") {
    return {
      note_id: { type: "string", description: "Attio note ID." },
    };
  }
  if (toolName === "attio/create_note") {
    return {
      parent_object: { type: "string", description: "Attio parent object slug or ID, e.g. people." },
      parent_record_id: { type: "string", description: "Attio parent record ID." },
      title: { type: "string", description: "Note title." },
      content: { type: "string", description: "Note content as Markdown." },
      created_at: { type: "string", description: "Optional ISO timestamp to backdate the note." },
      meeting_id: { type: "string", description: "Optional Attio meeting ID to associate with the note." },
      data: { type: "object", description: "Raw Attio note data; overrides individual fields when provided." },
    };
  }
  if (toolName === "attio/delete_note") {
    return {
      note_id: { type: "string", description: "Attio note ID." },
    };
  }
  if (toolName === "attio/list_tasks") {
    return {
      linked_object: { type: "string", description: "Optional linked object slug or ID." },
      linked_record_id: { type: "string", description: "Optional linked record ID. Use with linked_object." },
      assignee: { type: "string", description: "Optional assignee workspace member ID/email, or null for unassigned." },
      is_completed: { type: "boolean", description: "Filter tasks by completion state." },
      limit: { type: "number", minimum: 1, maximum: 50, description: "Tasks to return, max 50." },
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
    };
  }
  if (toolName === "attio/get_task") {
    return {
      task_id: { type: "string", description: "Attio task ID." },
    };
  }
  if (toolName === "attio/create_task") {
    return {
      content: { type: "string", description: "Task content as plaintext." },
      format: { type: "string", enum: ["plaintext"], description: "Task content format. Defaults to plaintext." },
      deadline_at: { type: "string", description: "Optional ISO deadline timestamp." },
      is_completed: { type: "boolean", description: "Initial completion state." },
      linked_records: { type: "array", items: { type: "string" }, description: "Optional linked record references, e.g. email/domain strings." },
      assignees: { type: "array", items: { type: "object" }, description: "Optional Attio assignee actor references." },
      data: { type: "object", description: "Raw Attio task data; overrides individual fields when provided." },
    };
  }
  if (toolName === "attio/update_task") {
    return {
      task_id: { type: "string", description: "Attio task ID." },
      deadline_at: { type: "string", description: "Optional ISO deadline timestamp." },
      is_completed: { type: "boolean", description: "Completion state." },
      linked_records: { type: "array", items: { type: "string" }, description: "Linked record references." },
      assignees: { type: "array", items: { type: "object" }, description: "Attio assignee actor references." },
      data: { type: "object", description: "Raw Attio task patch data; overrides individual fields when provided." },
    };
  }
  if (toolName === "attio/delete_task") {
    return {
      task_id: { type: "string", description: "Attio task ID." },
    };
  }
  if (toolName === "attio/list_threads") {
    return {
      object: { type: "string", description: "Optional object slug or ID. Use with record_id." },
      record_id: { type: "string", description: "Optional record ID. Use with object." },
      list: { type: "string", description: "Optional list slug or ID. Use with entry_id." },
      entry_id: { type: "string", description: "Optional list entry ID. Use with list." },
      limit: { type: "number", minimum: 1, maximum: 50, description: "Threads to return, max 50." },
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
    };
  }
  if (toolName === "attio/get_thread") {
    return {
      thread_id: { type: "string", description: "Attio thread ID." },
    };
  }
  if (toolName === "attio/create_comment") {
    return {
      content: { type: "string", description: "Comment content as plaintext." },
      format: { type: "string", enum: ["plaintext"], description: "Comment content format. Defaults to plaintext." },
      author: { type: "object", description: "Optional Attio author actor reference." },
      thread_id: { type: "string", description: "Existing thread ID for a reply." },
      record: { type: "object", description: "Record target for a new record comment, e.g. { object_id, record_id }." },
      entry: { type: "object", description: "List entry target for a new entry comment, e.g. { list_id, entry_id }." },
      created_at: { type: "string", description: "Optional ISO timestamp to backdate the comment." },
      data: { type: "object", description: "Raw Attio comment data; overrides individual fields when provided." },
    };
  }
  if (toolName === "attio/get_comment") {
    return {
      comment_id: { type: "string", description: "Attio comment ID." },
    };
  }
  if (toolName === "attio/delete_comment") {
    return {
      comment_id: { type: "string", description: "Attio comment ID." },
    };
  }
  if (toolName === "attio/list_meetings") {
    return {
      cursor: { type: "string", description: "Optional Attio pagination cursor." },
      linked_object: { type: "string", description: "Optional linked object slug or ID. Use with linked_record_id." },
      linked_record_id: { type: "string", description: "Optional linked record ID. Use with linked_object." },
      participants: { type: "string", description: "Optional comma-separated participant emails." },
      sort: { type: "string", enum: ["start_asc", "start_desc"], description: "Meeting sort order." },
      ends_from: { type: "string", description: "Optional inclusive end timestamp lower bound." },
      starts_before: { type: "string", description: "Optional exclusive start timestamp upper bound." },
      timezone: { type: "string", description: "Timezone for all-day meeting filters. Defaults to UTC." },
      limit: { type: "number", minimum: 1, maximum: 200, description: "Meetings to return, max 200." },
    };
  }
  if (toolName === "attio/get_meeting") {
    return {
      meeting_id: { type: "string", description: "Attio meeting ID." },
    };
  }
  if (toolName === "gmail/list_messages") {
    return {
      q: { type: "string", description: "Gmail search query." },
      max_results: { type: "number", minimum: 1, maximum: 100, description: "Messages to return, max 100." },
      page_token: { type: "string", description: "Optional Gmail page token." },
    };
  }
  if (toolName === "gmail/get_message") {
    return {
      message_id: { type: "string", description: "Gmail message id." },
      format: { type: "string", enum: ["minimal", "full", "raw", "metadata"], description: "Gmail message format. Defaults to metadata." },
    };
  }
  if (toolName === "gmail/send_message") {
    return {
      to: { type: "string", description: "Recipient email address." },
      cc: { type: "string", description: "Optional CC recipients." },
      bcc: { type: "string", description: "Optional BCC recipients." },
      subject: { type: "string", description: "Email subject." },
      body: { type: "string", description: "Email body." },
      reply_to: { type: "string", description: "Optional Reply-To address." },
      thread_id: { type: "string", description: "Optional Gmail thread id." },
      mime_type: { type: "string", description: "Content-Type, defaults to text/plain; charset=UTF-8." },
    };
  }
  if (toolName === "youtube/list_channels") {
    return {
      id: { type: "string", description: "Channel id(s) to fetch, comma-separated. Omit to fetch the authenticated user's channel." },
      for_username: { type: "string", description: "Optional legacy YouTube username to look up instead of id." },
      part: { type: "string", description: "Comma-separated channel parts. Defaults to snippet,contentDetails,statistics." },
      max_results: { type: "number", minimum: 1, maximum: 50, description: "Items to return, max 50." },
      page_token: { type: "string", description: "Optional pagination token." },
    };
  }
  if (toolName === "youtube/list_videos") {
    return {
      id: { type: "string", description: "Video id(s) to fetch, comma-separated." },
      part: { type: "string", description: "Comma-separated video parts. Defaults to snippet,contentDetails,statistics,status." },
      max_results: { type: "number", minimum: 1, maximum: 50, description: "Items to return, max 50." },
    };
  }
  if (toolName === "youtube/search") {
    return {
      q: { type: "string", description: "Search query string." },
      type: { type: "string", enum: ["video", "channel", "playlist"], description: "Restrict results to one resource type." },
      channel_id: { type: "string", description: "Restrict the search to one channel id." },
      order: { type: "string", enum: ["date", "rating", "relevance", "title", "videoCount", "viewCount"], description: "Result ordering. Defaults to relevance." },
      mine: { type: "boolean", description: "When true, search only the authenticated user's videos (sets forMine)." },
      max_results: { type: "number", minimum: 1, maximum: 50, description: "Items to return, max 50." },
      page_token: { type: "string", description: "Optional pagination token." },
    };
  }
  if (toolName === "youtube/list_playlists") {
    return {
      id: { type: "string", description: "Playlist id(s) to fetch, comma-separated." },
      channel_id: { type: "string", description: "List playlists for this channel id." },
      part: { type: "string", description: "Comma-separated playlist parts. Defaults to snippet,contentDetails,status." },
      max_results: { type: "number", minimum: 1, maximum: 50, description: "Items to return, max 50." },
      page_token: { type: "string", description: "Optional pagination token." },
    };
  }
  if (toolName === "youtube/list_playlist_items") {
    return {
      playlist_id: { type: "string", description: "Playlist id to list items for." },
      part: { type: "string", description: "Comma-separated parts. Defaults to snippet,contentDetails,status." },
      max_results: { type: "number", minimum: 1, maximum: 50, description: "Items to return, max 50." },
      page_token: { type: "string", description: "Optional pagination token." },
    };
  }
  if (toolName === "youtube/update_video") {
    return {
      id: { type: "string", description: "Video id to update." },
      snippet: { type: "object", description: "Video snippet fields to set, e.g. title, description, tags, categoryId. categoryId is required when a snippet is sent." },
      status: { type: "object", description: "Video status fields to set, e.g. privacyStatus, embeddable, license." },
    };
  }
  if (toolName === "youtube/create_playlist") {
    return {
      title: { type: "string", description: "Playlist title." },
      description: { type: "string", description: "Optional playlist description." },
      tags: { type: "array", items: { type: "string" }, description: "Optional playlist tags." },
      privacy_status: { type: "string", enum: ["private", "public", "unlisted"], description: "Playlist visibility. Defaults to private." },
    };
  }
  if (toolName === "youtube/update_playlist") {
    return {
      id: { type: "string", description: "Playlist id to update." },
      title: { type: "string", description: "Playlist title. Required because the YouTube API replaces the snippet on update." },
      description: { type: "string", description: "Optional playlist description." },
      tags: { type: "array", items: { type: "string" }, description: "Optional playlist tags." },
      privacy_status: { type: "string", enum: ["private", "public", "unlisted"], description: "Optional new visibility." },
    };
  }
  if (toolName === "youtube/delete_playlist") {
    return {
      id: { type: "string", description: "Playlist id to delete." },
    };
  }
  if (toolName === "youtube/add_playlist_item") {
    return {
      playlist_id: { type: "string", description: "Playlist id to add the video to." },
      video_id: { type: "string", description: "Video id to add." },
      position: { type: "number", minimum: 0, description: "Optional zero-based position within the playlist." },
    };
  }
  if (toolName === "youtube/delete_playlist_item") {
    return {
      id: { type: "string", description: "PlaylistItem id to remove (from list_playlist_items), not the video id." },
    };
  }
  if (toolName === "clay/raw_request") {
    return {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method. Defaults to GET." },
      path: { type: "string", description: "Clay API path, e.g. /v1/tables/{table_id}/rows. Do not include the host." },
      data: { type: "object", description: "Optional JSON body for POST/PUT/PATCH." },
      body: { type: "object", description: "Alias for data." },
    };
  }
  if (toolName === "clay/lookup_row") {
    return {
      table_id: { type: "string", description: "Clay table ID." },
      column: { type: "string", description: "Column to match." },
      value: { type: "string", description: "Value to match." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Rows to return." },
      data: { type: "object", description: "Raw Clay lookup request body; overrides individual fields." },
    };
  }
  if (toolName === "clay/create_row") {
    return {
      table_id: { type: "string", description: "Clay table ID." },
      data: { type: "object", description: "Row data to create." },
    };
  }
  if (toolName === "clay/update_row") {
    return {
      table_id: { type: "string", description: "Clay table ID." },
      row_id: { type: "string", description: "Clay row ID." },
      data: { type: "object", description: "Row data to patch." },
    };
  }
  if (toolName === "clay/enrich_person") {
    return {
      data: { type: "object", description: "Clay person enrichment request body." },
    };
  }
  if (toolName === "clay/enrich_company") {
    return {
      data: { type: "object", description: "Clay company enrichment request body." },
    };
  }
  if (toolName === "heyreach/check_api_key") {
    return {};
  }
  if (toolName === "heyreach/list_campaigns") {
    return {
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Campaigns to return, max 100." },
      data: { type: "object", description: "Optional raw HeyReach request body filters." },
    };
  }
  if (toolName === "heyreach/get_campaign" || toolName === "heyreach/pause_campaign" || toolName === "heyreach/resume_campaign") {
    return {
      campaign_id: { type: "string", description: "HeyReach campaign ID." },
    };
  }
  if (toolName === "heyreach/add_leads_to_campaign") {
    return {
      campaign_id: { type: "string", description: "HeyReach campaign ID." },
      leads: { type: "array", items: { type: "object" }, description: "Leads to add. Use raw HeyReach lead fields." },
      data: { type: "object", description: "Raw HeyReach AddLeadsToCampaignV2 request body; overrides individual fields." },
    };
  }
  if (toolName === "heyreach/list_leads") {
    return {
      campaign_id: { type: "string", description: "Optional campaign ID filter." },
      lead_list_id: { type: "string", description: "Optional lead list ID filter." },
      statuses: { type: "array", items: { type: "string" }, description: "Optional lead status filters." },
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Leads to return, max 100." },
      data: { type: "object", description: "Optional raw HeyReach request body filters." },
    };
  }
  if (toolName === "heyreach/list_conversations") {
    return {
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Conversations to return, max 100." },
      data: { type: "object", description: "Optional raw HeyReach GetConversationsV2 request body filters." },
    };
  }
  if (toolName === "heyreach/list_lead_lists") {
    return {
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Lead lists to return, max 100." },
      data: { type: "object", description: "Optional raw HeyReach request body filters." },
    };
  }
  if (toolName === "heyreach/create_empty_list") {
    return {
      name: { type: "string", description: "New HeyReach list name." },
      data: { type: "object", description: "Raw HeyReach CreateEmptyList request body; overrides name." },
    };
  }
  if (toolName === "heyreach/get_overall_stats") {
    return {
      data: { type: "object", description: "Raw HeyReach GetOverallStats request body, e.g. date/campaign filters." },
    };
  }
  if (toolName === "chatwork/get_me" || toolName === "chatwork/list_contacts" || toolName === "chatwork/list_rooms") {
    return {};
  }
  if (toolName === "chatwork/create_room") {
    return {
      name: { type: "string", description: "Group chat name (1-255 chars)." },
      members_admin_ids: { type: "array", items: { type: "string" }, description: "Account IDs to make admins (at least one required)." },
      members_member_ids: { type: "array", items: { type: "string" }, description: "Optional account IDs to add as members." },
      members_readonly_ids: { type: "array", items: { type: "string" }, description: "Optional account IDs to add as read-only." },
      description: { type: "string", description: "Optional chat overview." },
      icon_preset: { type: "string", description: "Optional chat icon preset, e.g. group, meeting, check, document." },
      link: { type: "boolean", description: "Optional: create an invite link." },
      link_code: { type: "string", description: "Optional custom invite link path (1-50 chars)." },
      link_need_acceptance: { type: "boolean", description: "Optional: require admin approval to join via the link." },
    };
  }
  if (toolName === "chatwork/get_room" || toolName === "chatwork/list_room_members") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
    };
  }
  if (toolName === "chatwork/update_room_members") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      members_admin_ids: { type: "array", items: { type: "string" }, description: "Full desired list of admin account IDs (replaces the whole roster; at least one required)." },
      members_member_ids: { type: "array", items: { type: "string" }, description: "Full desired list of member-level account IDs." },
      members_readonly_ids: { type: "array", items: { type: "string" }, description: "Full desired list of read-only account IDs." },
    };
  }
  if (toolName === "chatwork/list_messages") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      force: { type: "boolean", description: "When true, fetch the newest 100 messages regardless of previous calls." },
    };
  }
  if (toolName === "chatwork/get_message") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      message_id: { type: "string", description: "Chatwork message ID." },
    };
  }
  if (toolName === "chatwork/send_message") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      body: { type: "string", description: "Message body." },
      self_unread: { type: "boolean", description: "When true, leave the posted message unread for yourself." },
    };
  }
  if (toolName === "chatwork/list_my_tasks") {
    return {
      assigned_by_account_id: { type: "string", description: "Optional assigner account ID filter." },
      status: { type: "string", enum: ["open", "done"], description: "Task status filter." },
    };
  }
  if (toolName === "chatwork/list_room_tasks") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      account_id: { type: "string", description: "Optional assignee account ID filter." },
      assigned_by_account_id: { type: "string", description: "Optional assigner account ID filter." },
      status: { type: "string", enum: ["open", "done"], description: "Task status filter." },
    };
  }
  if (toolName === "chatwork/get_room_task") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      task_id: { type: "string", description: "Chatwork task ID." },
    };
  }
  if (toolName === "chatwork/create_room_task") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      body: { type: "string", description: "Task body." },
      to_ids: { type: "array", items: { type: "string" }, description: "Assignee account IDs." },
      limit: { type: "number", description: "Optional due date as Unix time." },
    };
  }
  if (toolName === "chatwork/list_room_files") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      account_id: { type: "string", description: "Optional uploader account ID filter." },
    };
  }
  if (toolName === "chatwork/get_room_file") {
    return {
      room_id: { type: "string", description: "Chatwork room ID." },
      file_id: { type: "string", description: "Chatwork file ID." },
      create_download_url: { type: "boolean", description: "When true, create a temporary download URL." },
    };
  }
  if (toolName === "railway/graphql") {
    return {
      query: { type: "string", description: "Railway GraphQL query or mutation." },
      variables: { type: "object", description: "GraphQL variables object." },
      operation_name: { type: "string", description: "Optional GraphQL operation name." },
    };
  }
  if (toolName === "railway/project_token_info") {
    return {};
  }
  if (toolName === "railway/introspect_schema") {
    return {};
  }
  if (toolName === "google_maps/geocode") {
    return {
      address: { type: "string", description: "Street address or place name to geocode, e.g. \"1600 Amphitheatre Parkway, Mountain View, CA\"." },
      components: { type: "string", description: "Optional component filter, e.g. \"country:JP|postal_code:100-0005\"." },
      bounds: { type: "string", description: "Optional viewport bias as \"lat,lng|lat,lng\"." },
      region: { type: "string", description: "Optional ccTLD region bias, e.g. jp." },
      language: { type: "string", description: "Optional result language, e.g. ja or en." },
    };
  }
  if (toolName === "google_maps/reverse_geocode") {
    return {
      latlng: { type: "string", description: "Latitude,longitude pair, e.g. \"35.6895,139.6917\". Alternatively pass lat and lng." },
      lat: { type: "number", description: "Latitude (used when latlng is not provided)." },
      lng: { type: "number", description: "Longitude (used when latlng is not provided)." },
      result_type: { type: "string", description: "Optional pipe-separated result types filter, e.g. \"street_address|locality\"." },
      location_type: { type: "string", description: "Optional pipe-separated location types filter, e.g. \"ROOFTOP\"." },
      language: { type: "string", description: "Optional result language, e.g. ja or en." },
    };
  }
  if (toolName === "google_maps/place_search") {
    return {
      query: { type: "string", description: "Free-text place search query, e.g. \"ramen near Shibuya station\"." },
      location: { type: "string", description: "Optional bias center as \"lat,lng\"." },
      radius: { type: "number", description: "Optional bias radius in meters (max 50000)." },
      type: { type: "string", description: "Optional place type filter, e.g. restaurant." },
      open_now: { type: "boolean", description: "When true, only return places open now." },
      page_token: { type: "string", description: "Pagination token (next_page_token) from a previous search." },
      region: { type: "string", description: "Optional ccTLD region bias, e.g. jp." },
      language: { type: "string", description: "Optional result language, e.g. ja or en." },
    };
  }
  if (toolName === "google_maps/place_details") {
    return {
      place_id: { type: "string", description: "Google place_id from a place_search result." },
      fields: { type: "string", description: "Optional comma-separated fields to return, e.g. \"name,formatted_address,geometry,opening_hours\"." },
      region: { type: "string", description: "Optional ccTLD region bias, e.g. jp." },
      language: { type: "string", description: "Optional result language, e.g. ja or en." },
    };
  }
  if (toolName === "google_maps/directions") {
    return {
      origin: { type: "string", description: "Start point: address, \"lat,lng\", or \"place_id:...\"." },
      destination: { type: "string", description: "End point: address, \"lat,lng\", or \"place_id:...\"." },
      mode: { type: "string", enum: ["driving", "walking", "bicycling", "transit"], description: "Travel mode. Defaults to driving." },
      waypoints: { type: "string", description: "Optional pipe-separated waypoints, e.g. \"Tokyo|Yokohama\"." },
      alternatives: { type: "boolean", description: "When true, return alternative routes." },
      avoid: { type: "string", description: "Optional pipe-separated features to avoid, e.g. \"tolls|highways\"." },
      departure_time: { type: "string", description: "Optional departure time (epoch seconds or \"now\")." },
      arrival_time: { type: "string", description: "Optional arrival time (epoch seconds), transit mode only." },
      units: { type: "string", enum: ["metric", "imperial"], description: "Unit system for distances." },
      language: { type: "string", description: "Optional result language, e.g. ja or en." },
      region: { type: "string", description: "Optional ccTLD region bias, e.g. jp." },
    };
  }
  if (toolName === "google_maps/distance_matrix") {
    return {
      origins: { type: "string", description: "Pipe-separated origins: addresses or \"lat,lng\", e.g. \"Tokyo|Osaka\"." },
      destinations: { type: "string", description: "Pipe-separated destinations: addresses or \"lat,lng\"." },
      mode: { type: "string", enum: ["driving", "walking", "bicycling", "transit"], description: "Travel mode. Defaults to driving." },
      avoid: { type: "string", description: "Optional pipe-separated features to avoid, e.g. \"tolls|highways\"." },
      departure_time: { type: "string", description: "Optional departure time (epoch seconds or \"now\")." },
      arrival_time: { type: "string", description: "Optional arrival time (epoch seconds), transit mode only." },
      units: { type: "string", enum: ["metric", "imperial"], description: "Unit system for distances." },
      language: { type: "string", description: "Optional result language, e.g. ja or en." },
      region: { type: "string", description: "Optional ccTLD region bias, e.g. jp." },
    };
  }
  if (toolName === "resend/send_email") {
    return {
      from: { type: "string", description: "Sender email address, e.g. Name <sender@example.com>." },
      to: { type: "array", items: { type: "string" }, description: "Recipient email address(es), max 50." },
      subject: { type: "string", description: "Email subject." },
      html: { type: "string", description: "HTML email body." },
      text: { type: "string", description: "Plain text email body." },
      cc: { type: "array", items: { type: "string" }, description: "Optional CC recipients." },
      bcc: { type: "array", items: { type: "string" }, description: "Optional BCC recipients." },
      reply_to: { type: "array", items: { type: "string" }, description: "Optional Reply-To address(es)." },
      scheduled_at: { type: "string", description: "Optional scheduled send time, e.g. in 1 hour or ISO timestamp." },
      attachments: { type: "array", items: { type: "object" }, description: "Optional Resend attachment objects." },
      tags: { type: "array", items: { type: "object" }, description: "Optional Resend tag objects." },
      headers: { type: "object", description: "Optional custom headers." },
      data: { type: "object", description: "Raw Resend send email body; overrides individual fields." },
    };
  }
  if (toolName === "resend/list_emails") {
    return {
      limit: { type: "number", minimum: 1, maximum: 100, description: "Emails to return." },
      after: { type: "string", description: "Pagination cursor/date lower bound." },
      before: { type: "string", description: "Pagination cursor/date upper bound." },
    };
  }
  if (toolName === "resend/get_email") {
    return {
      email_id: { type: "string", description: "Resend email ID." },
    };
  }
  if (toolName === "resend/list_domains") {
    return {};
  }
  if (toolName === "resend/get_domain") {
    return {
      domain_id: { type: "string", description: "Resend domain ID." },
    };
  }
  if (toolName === "resend/list_api_keys") {
    return {};
  }
  if (toolName === "slack/auth_test") {
    return {};
  }
  if (toolName === "slack/list_channels") {
    return {
      types: { type: "string", description: "Comma-separated conversation types: public_channel, private_channel, mpim, im. Defaults to public_channel." },
      limit: { type: "number", minimum: 1, maximum: 1000, description: "Max channels to return per page." },
      cursor: { type: "string", description: "Pagination cursor from a previous response_metadata.next_cursor." },
      exclude_archived: { type: "boolean", description: "When true, exclude archived channels." },
      team_id: { type: "string", description: "Encoded team id, required for org-level tokens." },
    };
  }
  if (toolName === "slack/get_channel") {
    return {
      channel: { type: "string", description: "Channel ID, e.g. C0123456789." },
      include_num_members: { type: "boolean", description: "When true, include the member count." },
    };
  }
  if (toolName === "slack/list_messages") {
    return {
      channel: { type: "string", description: "Channel ID to read history from." },
      limit: { type: "number", minimum: 1, maximum: 1000, description: "Max messages to return." },
      cursor: { type: "string", description: "Pagination cursor for the next page." },
      oldest: { type: "string", description: "Only messages after this timestamp (inclusive depends on inclusive)." },
      latest: { type: "string", description: "Only messages before this timestamp." },
      inclusive: { type: "boolean", description: "Include messages with oldest/latest timestamps." },
    };
  }
  if (toolName === "slack/get_thread") {
    return {
      channel: { type: "string", description: "Channel ID the thread is in." },
      ts: { type: "string", description: "Timestamp (ts) of the thread's parent message." },
      limit: { type: "number", minimum: 1, maximum: 1000, description: "Max replies to return." },
      cursor: { type: "string", description: "Pagination cursor for the next page." },
      oldest: { type: "string", description: "Only replies after this timestamp." },
      latest: { type: "string", description: "Only replies before this timestamp." },
      inclusive: { type: "boolean", description: "Include messages with oldest/latest timestamps." },
    };
  }
  if (toolName === "slack/post_message") {
    return {
      channel: { type: "string", description: "Channel ID, channel name (#general), or user ID for a DM." },
      text: { type: "string", description: "Message text. Required unless blocks or attachments are provided." },
      blocks: { type: "array", items: { type: "object" }, description: "Slack Block Kit blocks." },
      attachments: { type: "array", items: { type: "object" }, description: "Legacy message attachments." },
      thread_ts: { type: "string", description: "Parent message ts to post this as a threaded reply." },
      reply_broadcast: { type: "boolean", description: "When replying in a thread, also send to the channel." },
      unfurl_links: { type: "boolean", description: "Enable/disable link unfurling." },
      unfurl_media: { type: "boolean", description: "Enable/disable media unfurling." },
      mrkdwn: { type: "boolean", description: "Disable Slack markdown when false." },
    };
  }
  if (toolName === "slack/update_message") {
    return {
      channel: { type: "string", description: "Channel ID containing the message." },
      ts: { type: "string", description: "Timestamp (ts) of the message to update." },
      text: { type: "string", description: "New message text. Required unless blocks or attachments are provided." },
      blocks: { type: "array", items: { type: "object" }, description: "Replacement Block Kit blocks." },
      attachments: { type: "array", items: { type: "object" }, description: "Replacement attachments." },
      reply_broadcast: { type: "boolean", description: "Broadcast the threaded reply update to the channel." },
    };
  }
  if (toolName === "slack/create_channel") {
    return {
      name: { type: "string", description: "Channel name (lowercase, no spaces; hyphens/underscores allowed), e.g. root-andromeda." },
      is_private: { type: "boolean", description: "When true, create a private channel. Defaults to public." },
      team_id: { type: "string", description: "Encoded team id, required for org-level tokens." },
    };
  }
  if (toolName === "slack/invite_members") {
    return {
      channel: { type: "string", description: "Channel ID to invite members into, e.g. C0123456789." },
      users: { type: "array", items: { type: "string" }, description: "User IDs to invite (array or comma-separated string), e.g. [\"U012\",\"U345\"]." },
    };
  }
  if (toolName === "slack/open_group_dm") {
    return {
      users: { type: "array", items: { type: "string" }, description: "User IDs to include in the group DM (array or comma-separated string). Internal users only — external Slack Connect users cannot join an mpim." },
    };
  }
  if (toolName === "slack/invite_shared") {
    return {
      channel: { type: "string", description: "Channel ID to share externally via Slack Connect, e.g. C0123456789." },
      emails: { type: "array", items: { type: "string" }, description: "Email addresses of external people to invite (array or comma-separated). Use this or user_ids." },
      user_ids: { type: "array", items: { type: "string" }, description: "Slack user IDs of external people to invite. Use this or emails." },
      external_limited: { type: "boolean", description: "When true (default on Slack's side), invite as a limited external member." },
    };
  }
  if (toolName === "slack/list_users") {
    return {
      limit: { type: "number", minimum: 1, maximum: 1000, description: "Max users to return per page." },
      cursor: { type: "string", description: "Pagination cursor for the next page." },
      team_id: { type: "string", description: "Encoded team id, required for org-level tokens." },
    };
  }
  if (toolName === "slack/get_user") {
    return {
      user: { type: "string", description: "User ID, e.g. U0123456789." },
    };
  }
  if (toolName === "freee/get_me") {
    return {};
  }
  if (toolName === "freee/list_companies") {
    return {};
  }
  if (toolName === "freee/list_deals") {
    return {
      company_id: { type: "string", description: "freee company (事業所) id. Required." },
      partner_id: { type: "string", description: "Filter by partner (取引先) id." },
      account_item_id: { type: "string", description: "Filter by account item (勘定科目) id." },
      status: { type: "string", enum: ["unsettled", "settled"], description: "Settlement status filter." },
      type: { type: "string", enum: ["income", "expense"], description: "Deal type filter." },
      start_issue_date: { type: "string", description: "Issue date lower bound, YYYY-MM-DD." },
      end_issue_date: { type: "string", description: "Issue date upper bound, YYYY-MM-DD." },
      offset: { type: "number", description: "Pagination offset." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Deals to return, max 100." },
    };
  }
  if (toolName === "freee/get_deal") {
    return {
      company_id: { type: "string", description: "freee company (事業所) id. Required." },
      deal_id: { type: "string", description: "freee deal (取引) id. Required." },
    };
  }
  if (toolName === "freee/create_deal") {
    return {
      company_id: { type: "string", description: "freee company (事業所) id. Required." },
      issue_date: { type: "string", description: "Issue date, YYYY-MM-DD. Required." },
      type: { type: "string", enum: ["income", "expense"], description: "Deal type. Required." },
      details: { type: "array", items: { type: "object" }, description: "Deal line items (account_item_id, tax_code, amount, etc.)." },
      deal: { type: "object", description: "Raw freee deal body; overrides individual fields." },
    };
  }
  if (toolName === "freee/list_account_items") {
    return {
      company_id: { type: "string", description: "freee company (事業所) id. Required." },
    };
  }
  if (toolName === "freee/list_partners") {
    return {
      company_id: { type: "string", description: "freee company (事業所) id. Required." },
      keyword: { type: "string", description: "Partner name keyword filter." },
      offset: { type: "number", description: "Pagination offset." },
      limit: { type: "number", minimum: 1, maximum: 3000, description: "Partners to return." },
    };
  }
  if (toolName === "freee/create_partner") {
    return {
      company_id: { type: "string", description: "freee company (事業所) id. Required." },
      name: { type: "string", description: "Partner (取引先) name. Required." },
      partner: { type: "object", description: "Raw freee partner body; overrides individual fields." },
    };
  }
  if (toolName === "freee/trial_pl" || toolName === "freee/trial_bs") {
    return {
      company_id: { type: "string", description: "freee company (事業所) id. Required." },
      fiscal_year: { type: "number", description: "Fiscal year, e.g. 2026." },
      start_month: { type: "number", minimum: 1, maximum: 12, description: "Start month." },
      end_month: { type: "number", minimum: 1, maximum: 12, description: "End month." },
      breakdown_display_type: { type: "string", enum: ["partner", "item", "section", "account_item"], description: "Breakdown axis." },
    };
  }
  if (toolName === "moneyforward/accounting_request") {
    return {
      path: { type: "string", description: "Relative Cloud Accounting API path, e.g. /accounts. Required." },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method. Defaults to GET." },
      query: { type: "object", description: "Query parameters." },
      body: { type: "object", description: "JSON request body for write requests." },
    };
  }
  if (toolName === "moneyforward/accounting_get_journal") {
    return {
      journal_id: { type: "string", description: "Journal id. Required." },
    };
  }
  if (toolName === "moneyforward/accounting_list_journals") {
    return {
      query: {
        type: "object",
        description: "Query parameters such as start_date, end_date, account_id, is_realized, page, per_page. start_date or end_date is required by Money Forward.",
      },
    };
  }
  if (
    toolName === "moneyforward/accounting_trial_balance_bs"
    || toolName === "moneyforward/accounting_trial_balance_pl"
    || toolName === "moneyforward/accounting_transition_bs"
    || toolName === "moneyforward/accounting_transition_pl"
  ) {
    return {
      query: { type: "object", description: "Report query parameters supported by Money Forward, such as fiscal_year, start_month, end_month, start_date, end_date." },
    };
  }
  if (toolName.startsWith("moneyforward/accounting_")) {
    return {
      query: { type: "object", description: "Query parameters supported by the Money Forward Cloud Accounting endpoint." },
    };
  }
  if (toolName === "reddit/get_me") {
    return {};
  }
  if (toolName === "reddit/get_subreddit") {
    return {
      subreddit: { type: "string", description: "Subreddit name without the r/ prefix, e.g. programming." },
    };
  }
  if (toolName === "reddit/list_posts") {
    return {
      subreddit: { type: "string", description: "Subreddit name without the r/ prefix." },
      sort: { type: "string", enum: ["hot", "new", "top", "rising", "controversial"], description: "Listing sort. Defaults to hot." },
      time: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"], description: "Time window for top/controversial sort." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Number of posts to return, max 100." },
      after: { type: "string", description: "Pagination fullname cursor (after) from a previous listing." },
    };
  }
  if (toolName === "reddit/search") {
    return {
      query: { type: "string", description: "Search query." },
      subreddit: { type: "string", description: "Optional subreddit to restrict the search to (without r/ prefix)." },
      sort: { type: "string", enum: ["relevance", "hot", "top", "new", "comments"], description: "Search result sort." },
      time: { type: "string", enum: ["hour", "day", "week", "month", "year", "all"], description: "Time window for the search." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Number of results to return, max 100." },
      after: { type: "string", description: "Pagination fullname cursor (after) from a previous search." },
    };
  }
  if (toolName === "reddit/get_comments") {
    return {
      article: { type: "string", description: "Post ID (base36, with or without the t3_ prefix)." },
      subreddit: { type: "string", description: "Optional subreddit name (without r/ prefix)." },
      sort: { type: "string", enum: ["confidence", "top", "new", "controversial", "old", "qa"], description: "Comment sort." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Maximum number of comments to return." },
    };
  }
  if (toolName === "reddit/submit_post") {
    return {
      subreddit: { type: "string", description: "Target subreddit name without the r/ prefix." },
      title: { type: "string", description: "Post title." },
      kind: { type: "string", enum: ["self", "link"], description: "Post kind. Defaults to self (text) unless a url is given." },
      text: { type: "string", description: "Body text for a self post (markdown)." },
      url: { type: "string", description: "URL for a link post." },
      flair_id: { type: "string", description: "Optional flair template id." },
    };
  }
  if (toolName === "reddit/submit_comment") {
    return {
      parent: { type: "string", description: "Fullname of the thing to reply to, e.g. t3_<postid> or t1_<commentid>." },
      text: { type: "string", description: "Comment body (markdown)." },
    };
  }
  if (toolName === "reddit/vote") {
    return {
      id: { type: "string", description: "Fullname of the post or comment to vote on, e.g. t3_<id> or t1_<id>." },
      dir: { type: "string", enum: ["1", "0", "-1"], description: "Vote direction: 1 upvote, 0 clear, -1 downvote." },
    };
  }
  if (toolName === "x/get_me") {
    return {
      user_fields: { type: "string", description: "Optional comma-separated user.fields to expand." },
    };
  }
  if (toolName === "x/get_user") {
    return {
      username: { type: "string", description: "X username/handle without the @." },
      user_fields: { type: "string", description: "Optional comma-separated user.fields to expand." },
    };
  }
  if (toolName === "x/get_user_tweets") {
    return {
      user_id: { type: "string", description: "Numeric X user ID (use x/get_user to resolve a handle)." },
      max_results: { type: "number", minimum: 5, maximum: 100, description: "Tweets per page, 5-100." },
      pagination_token: { type: "string", description: "next_token from a previous page for pagination." },
      tweet_fields: { type: "string", description: "Optional comma-separated tweet.fields to expand." },
    };
  }
  if (toolName === "x/search_recent") {
    return {
      query: { type: "string", description: "Search query using X search operators." },
      max_results: { type: "number", minimum: 10, maximum: 100, description: "Tweets per page, 10-100." },
      next_token: { type: "string", description: "next_token from a previous page for pagination." },
      tweet_fields: { type: "string", description: "Optional comma-separated tweet.fields to expand." },
    };
  }
  if (toolName === "x/get_tweet") {
    return {
      id: { type: "string", description: "Tweet ID." },
      tweet_fields: { type: "string", description: "Optional comma-separated tweet.fields to expand." },
    };
  }
  if (toolName === "x/post_tweet") {
    return {
      text: { type: "string", description: "Tweet text, max 280 characters." },
      reply_to: { type: "string", description: "Optional tweet ID to reply to." },
      quote_tweet_id: { type: "string", description: "Optional tweet ID to quote." },
    };
  }
  if (toolName === "x/delete_tweet") {
    return {
      id: { type: "string", description: "ID of a tweet owned by the authorized account to delete." },
    };
  }
  if (toolName === "discord/get_me") {
    return {};
  }
  if (toolName === "discord/list_guilds") {
    return {
      before: { type: "string", description: "Get guilds before this guild ID (pagination)." },
      after: { type: "string", description: "Get guilds after this guild ID (pagination)." },
      limit: { type: "number", minimum: 1, maximum: 200, description: "Max guilds to return (default 200)." },
      with_counts: { type: "boolean", description: "Include approximate member/presence counts." },
    };
  }
  if (toolName === "discord/get_guild") {
    return {
      guild_id: { type: "string", description: "Discord guild (server) ID." },
      with_counts: { type: "boolean", description: "Include approximate member/presence counts." },
    };
  }
  if (toolName === "discord/list_channels") {
    return {
      guild_id: { type: "string", description: "Discord guild (server) ID." },
    };
  }
  if (toolName === "discord/get_channel") {
    return {
      channel_id: { type: "string", description: "Discord channel ID." },
    };
  }
  if (toolName === "discord/list_messages") {
    return {
      channel_id: { type: "string", description: "Discord channel ID." },
      around: { type: "string", description: "Get messages around this message ID." },
      before: { type: "string", description: "Get messages before this message ID." },
      after: { type: "string", description: "Get messages after this message ID." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Max messages to return (1-100, default 50)." },
    };
  }
  if (toolName === "discord/get_message") {
    return {
      channel_id: { type: "string", description: "Discord channel ID." },
      message_id: { type: "string", description: "Discord message ID." },
    };
  }
  if (toolName === "discord/send_message") {
    return {
      channel_id: { type: "string", description: "Discord channel ID to post into." },
      content: { type: "string", description: "Message text (up to 2000 chars). Required unless embeds or components are given." },
      embeds: { type: "array", items: { type: "object" }, description: "Up to 10 embed objects." },
      tts: { type: "boolean", description: "Send as a text-to-speech message." },
      allowed_mentions: { type: "object", description: "Allowed mentions object controlling which mentions ping." },
      message_reference: { type: "object", description: "Reference object to reply to another message ({ message_id, channel_id?, guild_id? })." },
      components: { type: "array", items: { type: "object" }, description: "Message component (action row) objects." },
      flags: { type: "number", description: "Message flags bitfield (e.g. 4 to suppress embeds)." },
    };
  }
  if (toolName === "discord/edit_message") {
    return {
      channel_id: { type: "string", description: "Discord channel ID." },
      message_id: { type: "string", description: "ID of the message to edit (must have been sent by the bot)." },
      content: { type: "string", description: "Replacement message text." },
      embeds: { type: "array", items: { type: "object" }, description: "Replacement embed objects." },
      allowed_mentions: { type: "object", description: "Allowed mentions object." },
      components: { type: "array", items: { type: "object" }, description: "Replacement component objects." },
      flags: { type: "number", description: "Message flags bitfield." },
    };
  }
  if (toolName === "discord/delete_message") {
    return {
      channel_id: { type: "string", description: "Discord channel ID." },
      message_id: { type: "string", description: "ID of the message to delete." },
    };
  }
  if (toolName === "discord/list_members") {
    return {
      guild_id: { type: "string", description: "Discord guild (server) ID. Requires the Server Members privileged intent." },
      limit: { type: "number", minimum: 1, maximum: 1000, description: "Max members to return (1-1000, default 1)." },
      after: { type: "string", description: "Get members after this user ID (pagination)." },
    };
  }
  if (toolName === "discord/get_user") {
    return {
      user_id: { type: "string", description: "Discord user ID." },
    };
  }
  if (toolName === "line/get_bot_info" || toolName === "line/get_quota" || toolName === "line/get_quota_consumption") {
    return {};
  }
  if (toolName === "line/get_profile") {
    return {
      user_id: { type: "string", description: "LINE user ID (from a webhook event or follower id)." },
    };
  }
  if (toolName === "line/push_message") {
    return {
      to: { type: "string", description: "Target ID: a user ID, group ID, or room ID." },
      text: { type: "string", description: "Convenience: send a single text message. Ignored when messages is provided." },
      messages: { type: "array", items: { type: "object" }, description: "Up to 5 LINE message objects (e.g. { type: 'text', text: '…' })." },
      notification_disabled: { type: "boolean", description: "When true, the user does not receive a push notification." },
      custom_aggregation_units: { type: "array", items: { type: "string" }, description: "Optional aggregation unit name(s) for statistics." },
    };
  }
  if (toolName === "line/reply_message") {
    return {
      reply_token: { type: "string", description: "Reply token from the webhook event being replied to." },
      text: { type: "string", description: "Convenience: reply with a single text message. Ignored when messages is provided." },
      messages: { type: "array", items: { type: "object" }, description: "Up to 5 LINE message objects." },
      notification_disabled: { type: "boolean", description: "When true, the user does not receive a push notification." },
    };
  }
  if (toolName === "line/multicast") {
    return {
      to: { type: "array", items: { type: "string" }, description: "User IDs to send to (max 500). A single string is also accepted." },
      text: { type: "string", description: "Convenience: send a single text message. Ignored when messages is provided." },
      messages: { type: "array", items: { type: "object" }, description: "Up to 5 LINE message objects." },
      notification_disabled: { type: "boolean", description: "When true, recipients do not receive a push notification." },
    };
  }
  if (toolName === "line/broadcast") {
    return {
      text: { type: "string", description: "Convenience: broadcast a single text message. Ignored when messages is provided." },
      messages: { type: "array", items: { type: "object" }, description: "Up to 5 LINE message objects sent to all friends." },
      notification_disabled: { type: "boolean", description: "When true, recipients do not receive a push notification." },
    };
  }
  if (toolName === "line/get_group_summary" || toolName === "line/get_group_member_count") {
    return {
      group_id: { type: "string", description: "LINE group ID." },
    };
  }
  if (toolName === "line/get_group_member_profile") {
    return {
      group_id: { type: "string", description: "LINE group ID." },
      user_id: { type: "string", description: "LINE user ID of a group member." },
    };
  }
  // --- facebook_messenger ---
  if (toolName === "facebook_messenger/get_page") {
    return {
      fields: { type: "string", description: "Comma-separated Page fields to return (default id,name,category)." },
    };
  }
  if (toolName === "facebook_messenger/get_user_profile") {
    return {
      psid: { type: "string", description: "Page-scoped user ID (PSID) of someone who has messaged the Page." },
      fields: { type: "string", description: "Comma-separated profile fields (default first_name,last_name,profile_pic)." },
    };
  }
  if (toolName === "facebook_messenger/list_conversations") {
    return {
      platform: { type: "string", description: "Inbox platform: messenger (default) or instagram." },
      fields: { type: "string", description: "Comma-separated conversation fields (default id,participants,updated_time,snippet,message_count,unread_count)." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Max conversations to return (1-100, default 25)." },
      after: { type: "string", description: "Pagination cursor (paging.cursors.after from a prior call)." },
    };
  }
  if (toolName === "facebook_messenger/get_conversation_messages") {
    return {
      conversation_id: { type: "string", description: "Conversation ID (from list_conversations)." },
      fields: { type: "string", description: "Comma-separated message fields (default id,message,from,to,created_time)." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Max messages to return (1-100, default 25)." },
      after: { type: "string", description: "Pagination cursor for the next page." },
    };
  }
  if (toolName === "facebook_messenger/send_message") {
    return {
      recipient_id: { type: "string", description: "Recipient PSID (the user's page-scoped ID)." },
      text: { type: "string", description: "Convenience: send a single text message. Ignored when message is provided." },
      message: { type: "object", description: "Raw Send API message object (e.g. { text } or { attachment }). Overrides text." },
      messaging_type: { type: "string", description: "RESPONSE (default), UPDATE, or MESSAGE_TAG. Use MESSAGE_TAG with tag outside the 24h window." },
      tag: { type: "string", description: "Message tag (e.g. CONFIRMED_EVENT_UPDATE) required when sending outside the 24h window." },
      notification_type: { type: "string", description: "REGULAR (default), SILENT_PUSH, or NO_PUSH." },
    };
  }
  if (toolName === "facebook_messenger/send_sender_action") {
    return {
      recipient_id: { type: "string", description: "Recipient PSID." },
      sender_action: { type: "string", enum: ["typing_on", "typing_off", "mark_seen"], description: "The sender action to send." },
    };
  }
  // --- airtable ---
  if (toolName === "airtable/list_tables") { return { base_id: { type: "string", description: "Airtable base id (appXXXXXXXXXXXXXX)." } }; }
  if (toolName === "airtable/list_records") {
    return {
      base_id: { type: "string", description: "Airtable base id." },
      table: { type: "string", description: "Table name or id." },
      max_records: { type: "number", description: "Maximum records to return." },
      view: { type: "string", description: "Optional view name or id." },
      page_size: { type: "number", description: "Records per page, max 100." },
      offset: { type: "string", description: "Pagination offset token." },
      filter_by_formula: { type: "string", description: "Airtable formula filter, e.g. {Status}='Active'." },
    };
  }
  if (toolName === "airtable/get_record" || toolName === "airtable/delete_record") {
    return {
      base_id: { type: "string", description: "Airtable base id." },
      table: { type: "string", description: "Table name or id." },
      record_id: { type: "string", description: "Airtable record id (recXXXXXXXXXXXXXX)." },
    };
  }
  if (toolName === "airtable/create_record") {
    return {
      base_id: { type: "string", description: "Airtable base id." },
      table: { type: "string", description: "Table name or id." },
      fields: { type: "object", description: "Field values for a single new record." },
      records: { type: "array", items: { type: "object" }, description: "Array of { fields } objects to create multiple records." },
    };
  }
  if (toolName === "airtable/update_record") {
    return {
      base_id: { type: "string", description: "Airtable base id." },
      table: { type: "string", description: "Table name or id." },
      record_id: { type: "string", description: "Airtable record id to update." },
      fields: { type: "object", description: "Field values to patch onto the record." },
    };
  }
  // --- linear ---
  if (toolName === "linear/list_issues") { return { first: { type: "number", description: "Number of issues to return. Defaults to 50." } }; }
  if (toolName === "linear/get_issue") { return { id: { type: "string", description: "Linear issue id (UUID or identifier like ENG-123)." } }; }
  if (toolName === "linear/search_issues") { return { query: { type: "string", description: "Full-text search term." } }; }
  if (toolName === "linear/create_issue") {
    return {
      team_id: { type: "string", description: "Linear team id (UUID)." },
      title: { type: "string", description: "Issue title." },
      description: { type: "string", description: "Optional issue description in Markdown." },
    };
  }
  if (toolName === "linear/update_issue") {
    return {
      id: { type: "string", description: "Linear issue id to update." },
      title: { type: "string", description: "New issue title." },
      description: { type: "string", description: "New issue description in Markdown." },
      stateId: { type: "string", description: "New workflow state id." },
      input: { type: "object", description: "Raw Linear IssueUpdateInput; overrides individual fields." },
    };
  }
  // --- sendgrid ---
  if (toolName === "sendgrid/send_email") {
    return {
      from: { type: "string", description: "Sender email (must be a verified sender)." },
      to: { type: "string", description: "Recipient email." },
      subject: { type: "string", description: "Subject line." },
      text: { type: "string", description: "Plain-text body." },
      html: { type: "string", description: "HTML body." },
      data: { type: "object", description: "Raw SendGrid /mail/send body; overrides individual fields." },
    };
  }
  if (toolName === "sendgrid/list_templates") { return { page_size: { type: "number", description: "Templates per page." } }; }
  if (toolName === "sendgrid/get_template") { return { template_id: { type: "string", description: "SendGrid dynamic template id (d-...)." } }; }
  if (toolName === "sendgrid/get_stats") {
    return {
      start_date: { type: "string", description: "Start date YYYY-MM-DD." },
      end_date: { type: "string", description: "End date YYYY-MM-DD." },
      aggregated_by: { type: "string", enum: ["day", "week", "month"], description: "Aggregation period." },
    };
  }
  if (toolName === "sendgrid/list_bounces") { return { start_time: { type: "number", description: "Unix timestamp lower bound." }, end_time: { type: "number", description: "Unix timestamp upper bound." } }; }
  // --- vercel ---
  if (toolName === "vercel/list_projects") { return { limit: { type: "number", description: "Projects to return." }, team_id: { type: "string", description: "Optional Vercel team id." } }; }
  if (toolName === "vercel/get_project") { return { project_id: { type: "string", description: "Vercel project id or name." } }; }
  if (toolName === "vercel/list_deployments") {
    return {
      limit: { type: "number", description: "Deployments to return." },
      project_id: { type: "string", description: "Filter by project id or name." },
      app: { type: "string", description: "Filter by app name." },
      team_id: { type: "string", description: "Optional Vercel team id." },
    };
  }
  if (toolName === "vercel/get_deployment") { return { deployment_id: { type: "string", description: "Vercel deployment id (dpl_...) or URL." } }; }
  if (toolName === "vercel/list_domains") { return { limit: { type: "number", description: "Domains to return." }, team_id: { type: "string", description: "Optional Vercel team id." } }; }
  // --- stripe ---
  if (toolName === "stripe/list_customers") { return { limit: { type: "number", description: "Max results." }, email: { type: "string", description: "Filter by email." }, starting_after: { type: "string", description: "Pagination cursor." } }; }
  if (toolName === "stripe/get_customer") { return { customer_id: { type: "string", description: "Stripe customer id (cus_...)." } }; }
  if (toolName === "stripe/create_customer") {
    return {
      email: { type: "string", description: "Customer email." },
      name: { type: "string", description: "Customer name." },
      description: { type: "string", description: "Internal description." },
      phone: { type: "string", description: "Phone number." },
      metadata: { type: "object", description: "Key-value metadata." },
      params: { type: "object", description: "Raw Stripe params passthrough." },
    };
  }
  if (toolName === "stripe/list_charges") { return { limit: { type: "number", description: "Max results." }, customer: { type: "string", description: "Filter by customer id." }, starting_after: { type: "string", description: "Pagination cursor." } }; }
  if (toolName === "stripe/list_payment_intents") { return { limit: { type: "number", description: "Max results." }, customer: { type: "string", description: "Filter by customer id." } }; }
  if (toolName === "stripe/create_payment_intent") {
    return {
      amount: { type: "number", description: "Amount in the smallest currency unit (e.g. cents)." },
      currency: { type: "string", description: "3-letter ISO currency code (e.g. usd)." },
      customer: { type: "string", description: "Customer id to attach." },
      description: { type: "string", description: "Description." },
      metadata: { type: "object", description: "Key-value metadata." },
    };
  }
  if (toolName === "stripe/list_invoices") { return { limit: { type: "number", description: "Max results." }, customer: { type: "string", description: "Filter by customer id." }, status: { type: "string", description: "draft, open, paid, uncollectible, or void." } }; }
  // --- webflow ---
  if (toolName === "webflow/get_site") { return { site_id: { type: "string", description: "Webflow site id." } }; }
  if (toolName === "webflow/list_collections") { return { site_id: { type: "string", description: "Webflow site id." } }; }
  if (toolName === "webflow/list_items") { return { collection_id: { type: "string", description: "Collection id." }, limit: { type: "number", description: "Max results." }, offset: { type: "number", description: "Pagination offset." } }; }
  if (toolName === "webflow/create_item") { return { collection_id: { type: "string", description: "Collection id." }, field_data: { type: "object", description: "Item field values keyed by field slug." } }; }
  if (toolName === "webflow/publish_site") { return { site_id: { type: "string", description: "Webflow site id to publish." } }; }
  // --- intercom ---
  if (toolName === "intercom/list_contacts" || toolName === "intercom/list_conversations") { return { per_page: { type: "number", description: "Results per page." }, starting_after: { type: "string", description: "Pagination cursor." } }; }
  if (toolName === "intercom/get_contact") { return { contact_id: { type: "string", description: "Intercom contact id." } }; }
  if (toolName === "intercom/search_contacts") { return { query: { type: "object", description: "Intercom search query object (field, operator, value)." } }; }
  if (toolName === "intercom/create_contact") {
    return {
      email: { type: "string", description: "Contact email (at least one of email/external_id required)." },
      name: { type: "string", description: "Contact name." },
      external_id: { type: "string", description: "Your system's user id." },
    };
  }
  if (toolName === "intercom/reply_conversation") {
    return {
      conversation_id: { type: "string", description: "Conversation id." },
      admin_id: { type: "string", description: "Admin/agent id sending the reply." },
      body: { type: "string", description: "Reply message text." },
    };
  }
  // --- customerio ---
  if (toolName === "customerio/send_transactional") {
    return {
      to: { type: "string", description: "Recipient email address." },
      transactional_message_id: { type: "string", description: "Transactional message template id." },
      identifiers: { type: "object", description: "Customer identifiers, e.g. {id:'123'}." },
      message_data: { type: "object", description: "Template variable data." },
      data: { type: "object", description: "Raw Customer.io send body passthrough." },
    };
  }
  if (toolName === "customerio/get_campaign" || toolName === "customerio/get_campaign_metrics") { return { campaign_id: { type: "string", description: "Campaign id." } }; }
  if (toolName === "customerio/get_customer") { return { customer_id: { type: "string", description: "Customer identifier." } }; }
  // --- mailchimp ---
  if (toolName === "mailchimp/get_list") { return { list_id: { type: "string", description: "Mailchimp audience/list id." } }; }
  if (toolName === "mailchimp/list_members") { return { list_id: { type: "string", description: "Mailchimp audience/list id." }, count: { type: "number", description: "Records to return." }, offset: { type: "number", description: "Pagination offset." }, status: { type: "string", description: "subscribed, unsubscribed, cleaned, or pending." } }; }
  if (toolName === "mailchimp/add_member") { return { list_id: { type: "string", description: "Mailchimp audience/list id." }, email_address: { type: "string", description: "Email to add." }, status: { type: "string", description: "Subscription status (default subscribed)." }, merge_fields: { type: "object", description: "Merge fields, e.g. {FNAME, LNAME}." } }; }
  if (toolName === "mailchimp/list_lists" || toolName === "mailchimp/list_campaigns") { return { count: { type: "number", description: "Records to return." }, offset: { type: "number", description: "Pagination offset." } }; }
  // --- zendesk ---
  if (toolName === "zendesk/list_tickets") { return { page: { type: "number", description: "Page number." }, per_page: { type: "number", description: "Results per page (max 100)." }, sort_by: { type: "string", description: "Sort field, e.g. created_at." } }; }
  if (toolName === "zendesk/get_ticket") { return { ticket_id: { type: "string", description: "Zendesk ticket id." } }; }
  if (toolName === "zendesk/create_ticket") { return { subject: { type: "string", description: "Ticket subject." }, body: { type: "string", description: "Initial comment body." } }; }
  if (toolName === "zendesk/update_ticket") { return { ticket_id: { type: "string", description: "Zendesk ticket id." }, status: { type: "string", description: "open, pending, solved, closed." }, priority: { type: "string", description: "low, normal, high, urgent." }, assignee_id: { type: "number", description: "Assignee user id." }, ticket: { type: "object", description: "Full ticket update object (overrides individual fields)." } }; }
  if (toolName === "zendesk/add_comment") { return { ticket_id: { type: "string", description: "Zendesk ticket id." }, body: { type: "string", description: "Comment text." }, public: { type: "boolean", description: "Public comment (default true)." } }; }
  if (toolName === "zendesk/search") { return { query: { type: "string", description: "Zendesk search query, e.g. type:ticket status:open." } }; }
  if (toolName === "zendesk/list_users") { return { page: { type: "number", description: "Page number." }, per_page: { type: "number", description: "Results per page." }, role: { type: "string", description: "end-user, agent, or admin." } }; }
  // --- wordpress ---
  if (toolName === "wordpress/list_posts") { return { per_page: { type: "number", description: "Posts per page (max 100)." }, page: { type: "number", description: "Page number." }, search: { type: "string", description: "Search keyword." }, status: { type: "string", description: "publish, draft, pending, private." } }; }
  if (toolName === "wordpress/get_post") { return { post_id: { type: "string", description: "WordPress post id." } }; }
  if (toolName === "wordpress/create_post") { return { title: { type: "string", description: "Post title." }, content: { type: "string", description: "Post body (HTML)." }, status: { type: "string", description: "publish, draft (default), pending, private." } }; }
  if (toolName === "wordpress/update_post") { return { post_id: { type: "string", description: "WordPress post id." }, title: { type: "string", description: "Post title." }, content: { type: "string", description: "Post body (HTML)." }, status: { type: "string", description: "Post status." } }; }
  if (toolName === "wordpress/list_pages") { return { per_page: { type: "number", description: "Pages per page." }, page: { type: "number", description: "Page number." }, search: { type: "string", description: "Search keyword." } }; }
  if (toolName === "wordpress/list_categories") { return { per_page: { type: "number", description: "Categories per page." } }; }
  // --- shopify ---
  if (toolName === "shopify/list_products") { return { limit: { type: "number", description: "Results (max 250)." }, status: { type: "string", description: "active, archived, draft." } }; }
  if (toolName === "shopify/get_product") { return { product_id: { type: "string", description: "Shopify product id." } }; }
  if (toolName === "shopify/create_product") { return { title: { type: "string", description: "Product title." }, body_html: { type: "string", description: "Product description HTML." }, vendor: { type: "string", description: "Product vendor/brand." }, status: { type: "string", description: "active, draft, archived." } }; }
  if (toolName === "shopify/list_orders") { return { limit: { type: "number", description: "Results (max 250)." }, status: { type: "string", description: "open, closed, cancelled, any." }, financial_status: { type: "string", description: "paid, pending, refunded, etc." } }; }
  if (toolName === "shopify/get_order") { return { order_id: { type: "string", description: "Shopify order id." } }; }
  if (toolName === "shopify/list_customers") { return { limit: { type: "number", description: "Results (max 250)." } }; }
  // --- jira ---
  if (toolName === "jira/search") { return { jql: { type: "string", description: "JQL query, e.g. project = ABC AND status = Open." }, max_results: { type: "number", description: "Max results (default 50)." }, fields: { type: "string", description: "Comma-separated fields to include." } }; }
  if (toolName === "jira/get_issue") { return { issue_key: { type: "string", description: "Jira issue key, e.g. PROJ-123." } }; }
  if (toolName === "jira/create_issue") { return { project_key: { type: "string", description: "Project key, e.g. PROJ." }, summary: { type: "string", description: "Issue summary/title." }, issue_type: { type: "string", description: "Issue type name, e.g. Bug, Task." }, description: { type: "string", description: "Plain-text description (converted to ADF)." } }; }
  if (toolName === "jira/update_issue") { return { issue_key: { type: "string", description: "Jira issue key." }, fields: { type: "object", description: "Fields to update, e.g. { summary: 'New' }." } }; }
  if (toolName === "jira/add_comment") { return { issue_key: { type: "string", description: "Jira issue key." }, body: { type: "string", description: "Plain-text comment (converted to ADF)." } }; }
  if (toolName === "jira/list_projects") { return { max_results: { type: "number", description: "Max projects." }, query: { type: "string", description: "Name filter." } }; }
  if (toolName === "jira/transition_issue") { return { issue_key: { type: "string", description: "Jira issue key." }, transition_id: { type: "string", description: "Transition id." } }; }
  // --- salesforce ---
  if (toolName === "salesforce/query") { return { soql: { type: "string", description: "SOQL query, e.g. SELECT Id, Name FROM Account LIMIT 10." } }; }
  if (toolName === "salesforce/search") { return { sosl: { type: "string", description: "SOSL search, e.g. FIND {Acme} IN ALL FIELDS RETURNING Account(Id,Name)." } }; }
  if (toolName === "salesforce/get_record") { return { sobject: { type: "string", description: "Object type, e.g. Account." }, record_id: { type: "string", description: "Record id." } }; }
  if (toolName === "salesforce/create_record") { return { sobject: { type: "string", description: "Object type to create." }, fields: { type: "object", description: "Field name/value pairs." } }; }
  if (toolName === "salesforce/update_record") { return { sobject: { type: "string", description: "Object type." }, record_id: { type: "string", description: "Record id." }, fields: { type: "object", description: "Field name/value pairs to update." } }; }
  if (toolName === "salesforce/delete_record") { return { sobject: { type: "string", description: "Object type." }, record_id: { type: "string", description: "Record id to delete." } }; }
  // --- linkedin_ads ---
  if (toolName === "linkedin_ads/list_ad_accounts") { return { start: { type: "number", description: "Pagination start index." }, count: { type: "number", description: "Results to return." } }; }
  if (toolName === "linkedin_ads/get_ad_account") { return { account_id: { type: "string", description: "LinkedIn ad account id (numeric)." } }; }
  if (toolName === "linkedin_ads/list_campaigns") { return { account_id: { type: "string", description: "LinkedIn ad account id." } }; }
  if (toolName === "linkedin_ads/get_campaign") { return { campaign_id: { type: "string", description: "LinkedIn ad campaign id." } }; }
  if (toolName === "linkedin_ads/get_analytics") { return { params: { type: "object", description: "Query params for the adAnalytics endpoint (dateRange, pivot, campaigns, etc.)." } }; }
  // --- tiktok_ads ---
  if (toolName === "tiktok_ads/get_advertiser_info") { return { advertiser_ids: { type: "array", items: { type: "string" }, description: "Advertiser ids (array or comma-separated string)." } }; }
  if (toolName === "tiktok_ads/list_campaigns" || toolName === "tiktok_ads/list_adgroups" || toolName === "tiktok_ads/list_ads") { return { advertiser_id: { type: "string", description: "TikTok advertiser account id." }, page: { type: "number", description: "Page number." }, page_size: { type: "number", description: "Results per page." } }; }
  if (toolName === "tiktok_ads/get_report") { return { advertiser_id: { type: "string", description: "TikTok advertiser account id." }, params: { type: "object", description: "Report params (report_type, dimensions, metrics, start_date, end_date). Arrays/objects are JSON-encoded." } }; }
  // --- microsoft_ads ---
  if (toolName === "microsoft_ads/get_accounts_info") { return { customer_id: { type: "string", description: "Customer id (defaults to the value in the credential)." } }; }
  // --- aws ---
  if (toolName === "aws/s3_list_objects") { return { bucket: { type: "string", description: "S3 bucket name." } }; }
  // --- snowflake ---
  if (toolName === "snowflake/execute_statement") {
    return {
      statement: { type: "string", description: "SQL statement to execute." },
      warehouse: { type: "string", description: "Warehouse override (defaults to credential)." },
      database: { type: "string", description: "Database override." },
      schema: { type: "string", description: "Schema override." },
      role: { type: "string", description: "Role override." },
      timeout: { type: "number", description: "Statement timeout in seconds." },
    };
  }
  if (toolName === "snowflake/get_statement" || toolName === "snowflake/cancel_statement") { return { statement_handle: { type: "string", description: "Statement handle (UUID) from execute_statement." } }; }
  // --- google_calendar ---
  if (toolName === "google_calendar/list_events") {
    return {
      calendar_id: { type: "string", description: "Calendar id (e.g. primary)." },
      time_min: { type: "string", description: "RFC3339 lower bound for event start." },
      time_max: { type: "string", description: "RFC3339 upper bound." },
      q: { type: "string", description: "Free-text search." },
      max_results: { type: "number", description: "Max events." },
      single_events: { type: "boolean", description: "Expand recurring events." },
      order_by: { type: "string", description: "startTime or updated." },
    };
  }
  if (toolName === "google_calendar/get_event" || toolName === "google_calendar/delete_event") { return { calendar_id: { type: "string", description: "Calendar id." }, event_id: { type: "string", description: "Event id." } }; }
  if (toolName === "google_calendar/create_event") {
    return {
      calendar_id: { type: "string", description: "Calendar id (e.g. primary)." },
      start: { type: "object", description: "Event start, e.g. { dateTime: '2026-06-12T10:00:00+09:00' } or { date: '2026-06-12' }." },
      end: { type: "object", description: "Event end (same shape as start)." },
      summary: { type: "string", description: "Event title." },
      description: { type: "string", description: "Event description." },
      location: { type: "string", description: "Event location." },
      attendees: { type: "array", items: { type: "object" }, description: "Attendees, e.g. [{ email }]." },
    };
  }
  if (toolName === "google_calendar/update_event") { return { calendar_id: { type: "string", description: "Calendar id." }, event_id: { type: "string", description: "Event id." }, summary: { type: "string", description: "Event title." }, description: { type: "string", description: "Description." }, start: { type: "object", description: "Event start." }, end: { type: "object", description: "Event end." } }; }
  // --- google_sheets ---
  if (toolName === "google_sheets/get_spreadsheet") { return { spreadsheet_id: { type: "string", description: "Spreadsheet id." }, ranges: { type: "array", items: { type: "string" }, description: "A1 ranges to include." }, include_grid_data: { type: "boolean", description: "Include cell data." } }; }
  if (toolName === "google_sheets/get_values") { return { spreadsheet_id: { type: "string", description: "Spreadsheet id." }, range: { type: "string", description: "A1 range, e.g. Sheet1!A1:C10." } }; }
  if (toolName === "google_sheets/batch_get_values") { return { spreadsheet_id: { type: "string", description: "Spreadsheet id." }, ranges: { type: "array", items: { type: "string" }, description: "A1 ranges." } }; }
  if (toolName === "google_sheets/update_values") { return { spreadsheet_id: { type: "string", description: "Spreadsheet id." }, range: { type: "string", description: "A1 range to write." }, values: { type: "array", items: { type: "array" }, description: "2D array of row values." }, value_input_option: { type: "string", description: "USER_ENTERED (default) or RAW." } }; }
  if (toolName === "google_sheets/append_values") { return { spreadsheet_id: { type: "string", description: "Spreadsheet id." }, range: { type: "string", description: "A1 range to append after." }, values: { type: "array", items: { type: "array" }, description: "2D array of row values." }, value_input_option: { type: "string", description: "USER_ENTERED (default) or RAW." } }; }
  if (toolName === "google_sheets/create_spreadsheet") { return { title: { type: "string", description: "New spreadsheet title." } }; }
  // --- google_tag_manager ---
  if (toolName === "google_tag_manager/list_containers") { return { account_id: { type: "string", description: "GTM account id." } }; }
  if (toolName === "google_tag_manager/get_container") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." } }; }
  if (toolName === "google_tag_manager/list_workspaces") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." } }; }
  if (toolName === "google_tag_manager/list_tags") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." }, workspace_id: { type: "string", description: "GTM workspace id." } }; }
  if (toolName === "google_tag_manager/create_tag") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." }, workspace_id: { type: "string", description: "GTM workspace id." }, tag: { type: "object", description: "Raw GTM Tag resource, e.g. a GA4 config tag: {\"name\":\"GA4 Config\",\"type\":\"googtag\",\"parameter\":[{\"type\":\"template\",\"key\":\"tagId\",\"value\":\"G-XXXX\"}],\"firingTriggerId\":[\"2147479553\"]}. 2147479553 is the built-in All Pages trigger." } }; }
  if (toolName === "google_tag_manager/create_version") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." }, workspace_id: { type: "string", description: "GTM workspace id." }, name: { type: "string", description: "Optional version name." }, notes: { type: "string", description: "Optional version notes." } }; }
  if (toolName === "google_tag_manager/publish_version") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." }, version_id: { type: "string", description: "GTM container version id (from create_version's containerVersion.containerVersionId)." } }; }
  // --- google_cloud ---
  if (toolName === "google_cloud/list_projects") { return { filter: { type: "string", description: "Project list filter." }, page_size: { type: "number", description: "Results per page." }, page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "google_cloud/get_project") { return { project_id: { type: "string", description: "GCP project id." } }; }
  if (toolName === "google_cloud/list_services") { return { project_id: { type: "string", description: "GCP project id." }, page_size: { type: "number", description: "Results per page." }, page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "google_cloud/list_log_entries") { return { project_id: { type: "string", description: "GCP project id." }, filter: { type: "string", description: "Cloud Logging filter expression." }, order_by: { type: "string", description: "timestamp asc or timestamp desc." }, page_size: { type: "number", description: "Max entries (default 50)." } }; }
  if (toolName === "google_cloud/list_billing_accounts") { return { filter: { type: "string", description: "Billing account list filter." }, page_size: { type: "number", description: "Results per page." }, page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "google_cloud/get_billing_account") { return { billing_account_id: { type: "string", description: "Billing account id, e.g. 012345-567890-ABCDEF or billingAccounts/012345-567890-ABCDEF." } }; }
  if (toolName === "google_cloud/list_billing_account_projects") { return { billing_account_id: { type: "string", description: "Billing account id (012345-567890-ABCDEF)." }, page_size: { type: "number", description: "Results per page." }, page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "google_cloud/get_project_billing_info") { return { project_id: { type: "string", description: "GCP project id whose billing info to read (billing account, billing enabled)." } }; }
  if (toolName === "google_cloud/list_billing_services") { return { page_size: { type: "number", description: "Results per page." }, page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "google_cloud/list_skus") { return { service_id: { type: "string", description: "Catalog service id (from list_billing_services), e.g. 6F81-5844-456A for Compute Engine." }, currency_code: { type: "string", description: "ISO currency code for prices, e.g. USD or JPY." }, start_time: { type: "string", description: "RFC3339 start of the price window." }, end_time: { type: "string", description: "RFC3339 end of the price window." }, page_size: { type: "number", description: "Results per page." }, page_token: { type: "string", description: "Pagination token." } }; }
  // --- bigquery ---
  if (toolName === "bigquery/list_datasets") { return { project_id: { type: "string", description: "GCP project id." }, max_results: { type: "number", description: "Max datasets." }, all: { type: "boolean", description: "Include hidden datasets." } }; }
  if (toolName === "bigquery/list_tables") { return { project_id: { type: "string", description: "GCP project id." }, dataset_id: { type: "string", description: "Dataset id." }, max_results: { type: "number", description: "Max tables." } }; }
  if (toolName === "bigquery/get_table") { return { project_id: { type: "string", description: "GCP project id." }, dataset_id: { type: "string", description: "Dataset id." }, table_id: { type: "string", description: "Table id." } }; }
  if (toolName === "bigquery/query") { return { project_id: { type: "string", description: "GCP project id (billing project)." }, query: { type: "string", description: "Standard SQL query." }, max_results: { type: "number", description: "Max rows to return." }, use_legacy_sql: { type: "boolean", description: "Use legacy SQL (default false)." }, dry_run: { type: "boolean", description: "Validate without running." } }; }
  if (toolName === "bigquery/get_job") { return { project_id: { type: "string", description: "GCP project id." }, job_id: { type: "string", description: "Job id." }, location: { type: "string", description: "Job location." } }; }
  // --- google_admin (Admin SDK Directory API) ---
  if (toolName === "google_admin/list_users") {
    return {
      customer: { type: "string", description: "Customer id (default 'my_customer'). Ignored if domain is set." },
      domain: { type: "string", description: "Restrict to a specific domain." },
      query: { type: "string", description: "Search query, e.g. \"email:jane*\" or \"orgUnitPath=/Sales\"." },
      max_results: { type: "number", description: "Max users per page (1-500)." },
      order_by: { type: "string", description: "email, givenName, or familyName." },
      sort_order: { type: "string", description: "ASCENDING or DESCENDING." },
      page_token: { type: "string", description: "Pagination token." },
      show_deleted: { type: "string", description: "'true' to list recently deleted users." },
      view_type: { type: "string", description: "admin_view (default) or domain_public." },
      projection: { type: "string", description: "basic, full, or custom." },
    };
  }
  if (toolName === "google_admin/get_user") { return { user_key: { type: "string", description: "User's primary email or unique id." }, projection: { type: "string", description: "basic, full, or custom." }, view_type: { type: "string", description: "admin_view or domain_public." } }; }
  if (toolName === "google_admin/create_user") {
    return {
      primaryEmail: { type: "string", description: "Primary email address." },
      name: { type: "object", description: "Name object, e.g. { givenName, familyName }." },
      password: { type: "string", description: "Initial password (plaintext or hashed; see hashFunction)." },
      suspended: { type: "boolean", description: "Create the user suspended." },
      orgUnitPath: { type: "string", description: "Org unit path, e.g. /Sales." },
      changePasswordAtNextLogin: { type: "boolean", description: "Force password change on first login." },
      emails: { type: "array", items: { type: "object" }, description: "Additional emails." },
      phones: { type: "array", items: { type: "object" }, description: "Phone numbers." },
    };
  }
  if (toolName === "google_admin/update_user") {
    return {
      user_key: { type: "string", description: "User's primary email or unique id." },
      primaryEmail: { type: "string", description: "New primary email." },
      name: { type: "object", description: "Name object, e.g. { givenName, familyName }." },
      password: { type: "string", description: "New password." },
      suspended: { type: "boolean", description: "Suspend (true) or unsuspend (false) the user." },
      orgUnitPath: { type: "string", description: "Move the user to this org unit path." },
      changePasswordAtNextLogin: { type: "boolean", description: "Force password change on next login." },
      archived: { type: "boolean", description: "Archive (true) or unarchive (false)." },
    };
  }
  if (toolName === "google_admin/delete_user") { return { user_key: { type: "string", description: "User's primary email or unique id." } }; }
  if (toolName === "google_admin/list_groups") {
    return {
      customer: { type: "string", description: "Customer id (default 'my_customer'). Ignored if domain or user_key is set." },
      domain: { type: "string", description: "Restrict to a specific domain." },
      user_key: { type: "string", description: "List groups this user is a member of." },
      query: { type: "string", description: "Search query, e.g. \"email:team*\"." },
      max_results: { type: "number", description: "Max groups per page (1-200)." },
      order_by: { type: "string", description: "email." },
      sort_order: { type: "string", description: "ASCENDING or DESCENDING." },
      page_token: { type: "string", description: "Pagination token." },
    };
  }
  if (toolName === "google_admin/get_group") { return { group_key: { type: "string", description: "Group's email or unique id." } }; }
  if (toolName === "google_admin/create_group") { return { email: { type: "string", description: "Group email address." }, name: { type: "string", description: "Display name." }, description: { type: "string", description: "Group description." } }; }
  if (toolName === "google_admin/update_group") { return { group_key: { type: "string", description: "Group's email or unique id." }, email: { type: "string", description: "New group email." }, name: { type: "string", description: "Display name." }, description: { type: "string", description: "Group description." } }; }
  if (toolName === "google_admin/delete_group") { return { group_key: { type: "string", description: "Group's email or unique id." } }; }
  if (toolName === "google_admin/list_members") {
    return {
      group_key: { type: "string", description: "Group's email or unique id." },
      roles: { type: "string", description: "Comma-separated roles filter: OWNER, MANAGER, MEMBER." },
      max_results: { type: "number", description: "Max members per page (1-200)." },
      page_token: { type: "string", description: "Pagination token." },
      include_derived_membership: { type: "boolean", description: "Include indirect (nested group) members." },
    };
  }
  if (toolName === "google_admin/add_member") { return { group_key: { type: "string", description: "Group's email or unique id." }, email: { type: "string", description: "Member's email address." }, role: { type: "string", description: "OWNER, MANAGER, or MEMBER (default MEMBER)." }, type: { type: "string", description: "USER, GROUP, etc." }, delivery_settings: { type: "string", description: "Email delivery preference." } }; }
  if (toolName === "google_admin/update_member") { return { group_key: { type: "string", description: "Group's email or unique id." }, member_key: { type: "string", description: "Member's email or unique id." }, role: { type: "string", description: "OWNER, MANAGER, or MEMBER." }, type: { type: "string", description: "USER, GROUP, etc." }, delivery_settings: { type: "string", description: "Email delivery preference." } }; }
  if (toolName === "google_admin/remove_member") { return { group_key: { type: "string", description: "Group's email or unique id." }, member_key: { type: "string", description: "Member's email or unique id." } }; }
  if (toolName === "google_admin/list_org_units") { return { customer: { type: "string", description: "Customer id (default 'my_customer')." }, org_unit_path: { type: "string", description: "Parent path to list children of, e.g. /Sales." }, type: { type: "string", description: "all (default) or children." } }; }
  if (toolName === "google_admin/get_org_unit") { return { customer: { type: "string", description: "Customer id (default 'my_customer')." }, org_unit_path: { type: "string", description: "Org unit path, e.g. /Sales/Engineering." } }; }
  if (toolName === "google_admin/create_org_unit") { return { customer: { type: "string", description: "Customer id (default 'my_customer')." }, name: { type: "string", description: "Org unit name." }, parentOrgUnitPath: { type: "string", description: "Parent path, e.g. / or /Sales." }, description: { type: "string", description: "Description." }, blockInheritance: { type: "boolean", description: "Block policy inheritance from parent." } }; }
  if (toolName === "google_admin/update_org_unit") { return { customer: { type: "string", description: "Customer id (default 'my_customer')." }, org_unit_path: { type: "string", description: "Org unit path to update, e.g. /Sales." }, name: { type: "string", description: "New name." }, description: { type: "string", description: "Description." }, parentOrgUnitPath: { type: "string", description: "Move under this parent path." }, blockInheritance: { type: "boolean", description: "Block policy inheritance." } }; }
  if (toolName === "google_admin/delete_org_unit") { return { customer: { type: "string", description: "Customer id (default 'my_customer')." }, org_unit_path: { type: "string", description: "Org unit path to delete, e.g. /Sales/Old." } }; }
  // --- zoom ---
  if (toolName === "zoom/get_me") { return {}; }
  if (toolName === "zoom/list_users") { return { status: { type: "string", enum: ["active", "inactive", "pending"], description: "User status filter (default active)." }, role_id: { type: "string", description: "Filter by role id." }, page_size: { type: "number", description: "Results per page (max 300)." }, next_page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "zoom/list_recordings") { return { user_id: { type: "string", description: "Zoom user id or email; defaults to 'me'." }, from: { type: "string", description: "Start date YYYY-MM-DD (recordings within the last month by default)." }, to: { type: "string", description: "End date YYYY-MM-DD." }, page_size: { type: "number", description: "Results per page (max 300)." }, next_page_token: { type: "string", description: "Pagination token." }, trash: { type: "boolean", description: "List recordings in the trash." } }; }
  if (toolName === "zoom/get_meeting_recordings") { return { meeting_id: { type: "string", description: "Meeting ID (numeric) or meeting UUID. UUIDs are handled (double-encoded) automatically." }, include_fields: { type: "string", description: "Optional extra fields, e.g. 'download_access_token'." } }; }
  if (toolName === "zoom/list_meetings") { return { user_id: { type: "string", description: "Zoom user id or email; defaults to 'me'." }, type: { type: "string", enum: ["scheduled", "live", "upcoming", "upcoming_meetings", "previous_meetings"], description: "Meeting type filter (default scheduled)." }, page_size: { type: "number", description: "Results per page (max 300)." }, next_page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "zoom/get_meeting") { return { meeting_id: { type: "string", description: "Meeting ID." }, occurrence_id: { type: "string", description: "Occurrence id for recurring meetings." } }; }
  if (toolName === "zoom/create_meeting") { return { user_id: { type: "string", description: "Host user id or email; defaults to 'me'." }, topic: { type: "string", description: "Meeting topic." }, type: { type: "number", description: "1 instant, 2 scheduled (default), 3 recurring no fixed time, 8 recurring fixed time." }, start_time: { type: "string", description: "ISO 8601 start time, e.g. 2026-06-20T09:00:00Z." }, duration: { type: "number", description: "Duration in minutes." }, timezone: { type: "string", description: "IANA timezone, e.g. Asia/Tokyo." }, agenda: { type: "string", description: "Meeting agenda." }, settings: { type: "object", description: "Zoom meeting settings object." } }; }
  if (toolName === "zoom/get_meeting_participants") { return { meeting_id: { type: "string", description: "Meeting ID (numeric) or meeting UUID of a past meeting." }, page_size: { type: "number", description: "Results per page (max 300)." }, next_page_token: { type: "string", description: "Pagination token." } }; }
  return {};
}

function requiredToolSpecificArgs(toolName: string): string[] {
  if (SYSTEM_TOOLS.includes(toolName as any)) return [];
  if (toolName === "github/get_file_contents") return ["owner", "repo"];
  if (toolName === "github/get_repo") return ["owner", "repo"];
  if (toolName === "github/list_issues") return ["owner", "repo"];
  if (toolName === "github/create_issue") return ["owner", "repo", "title"];
  if (toolName === "github/git_push_repo") return ["owner", "repo", "files"];
  if (toolName === "github/create_repo") return ["name"];
  if (toolName === "notion/get_page") return ["page_id"];
  if (toolName === "notion/query_db") return ["database_id"];
  if (toolName === "notion/create_page") return ["parent", "properties"];
  if (toolName === "notion/update_page") return ["page_id"];
  if (toolName === "notion/append_blocks") return ["children"];
  if (toolName === "notion/update_blocks") return ["operations"];
  if (toolName === "notion/update_page_status") return ["page_id", "status"];
  if (toolName === "cloudflare/get_zone") return ["zone_id"];
  if (toolName === "cloudflare/list_dns_records") return ["zone_id"];
  if (toolName === "cloudflare/create_dns_record") return ["zone_id", "type", "name", "content"];
  if (toolName === "cloudflare/update_dns_record") return ["zone_id", "record_id"];
  if (toolName === "cloudflare/delete_dns_record") return ["zone_id", "record_id"];
  if (toolName === "cloudflare/purge_cache") return ["zone_id"];
  if (toolName === "google_drive/get_file") return ["file_id"];
  if (toolName === "google_gsc/search_analytics") return ["site_url", "start_date", "end_date"];
  if (toolName === "google_analytics/run_report") return ["property_id", "start_date", "end_date"];
  if (toolName === "google_ads/search") return ["customer_id", "query"];
  if (toolName === "google_ads/mutate") return ["customer_id", "operations"];
  if (toolName === "yahoo_ads/get") return ["base_account_id", "service"];
  if (toolName === "yahoo_ads/mutate") return ["base_account_id", "service", "method"];
  if (toolName === "meta_ads/get_ad_account") return ["account_id"];
  if (toolName === "meta_ads/list_campaigns") return ["account_id"];
  if (toolName === "meta_ads/get_campaign") return ["campaign_id"];
  if (toolName === "meta_ads/create_campaign") return ["account_id", "campaign"];
  if (toolName === "meta_ads/update_campaign") return ["campaign_id", "updates"];
  if (toolName === "hubspot/get_contact") return ["contact_id"];
  if (toolName === "hubspot/create_deal") return ["properties"];
  if (toolName === "hubspot/update_marketing_email") return ["email_id", "confirm"];
  if (toolName === "hubspot/publish_marketing_email") return ["email_id", "confirm"];
  if (toolName.endsWith("/request")) return ["path"];
  if (toolName.endsWith("/check_connection")) return [];
  if (toolName.endsWith("/list_capabilities")) return [];
  if (toolName === "attio/search_records") return ["query", "objects"];
  if (toolName === "attio/list_records") return ["object"];
  if (toolName === "attio/get_record") return ["object", "record_id"];
  if (toolName === "attio/create_record") return ["object", "values"];
  if (toolName === "attio/upsert_record") return ["object", "matching_attribute", "values"];
  if (toolName === "attio/update_record") return ["object", "record_id", "values"];
  if (toolName === "attio/get_note") return ["note_id"];
  if (toolName === "attio/create_note") return ["parent_object", "parent_record_id", "title", "content"];
  if (toolName === "attio/delete_note") return ["note_id"];
  if (toolName === "attio/get_task") return ["task_id"];
  if (toolName === "attio/create_task") return ["content"];
  if (toolName === "attio/update_task") return ["task_id"];
  if (toolName === "attio/delete_task") return ["task_id"];
  if (toolName === "attio/get_thread") return ["thread_id"];
  if (toolName === "attio/create_comment") return ["content"];
  if (toolName === "attio/get_comment") return ["comment_id"];
  if (toolName === "attio/delete_comment") return ["comment_id"];
  if (toolName === "attio/get_meeting") return ["meeting_id"];
  if (toolName === "gmail/get_message") return ["message_id"];
  if (toolName === "gmail/send_message") return ["to", "subject", "body"];
  if (toolName === "youtube/list_videos") return ["id"];
  if (toolName === "youtube/list_playlist_items") return ["playlist_id"];
  if (toolName === "youtube/update_video") return ["id"];
  if (toolName === "youtube/create_playlist") return ["title"];
  if (toolName === "youtube/update_playlist") return ["id", "title"];
  if (toolName === "youtube/delete_playlist") return ["id"];
  if (toolName === "youtube/add_playlist_item") return ["playlist_id", "video_id"];
  if (toolName === "youtube/delete_playlist_item") return ["id"];
  if (toolName === "clay/raw_request") return ["path"];
  if (toolName === "clay/lookup_row") return ["table_id"];
  if (toolName === "clay/create_row") return ["table_id", "data"];
  if (toolName === "clay/update_row") return ["table_id", "row_id", "data"];
  if (toolName === "clay/enrich_person") return ["data"];
  if (toolName === "clay/enrich_company") return ["data"];
  if (toolName === "heyreach/get_campaign") return ["campaign_id"];
  if (toolName === "heyreach/pause_campaign") return ["campaign_id"];
  if (toolName === "heyreach/resume_campaign") return ["campaign_id"];
  if (toolName === "heyreach/add_leads_to_campaign") return [];
  if (toolName === "heyreach/create_empty_list") return [];
  if (toolName === "chatwork/create_room") return ["name", "members_admin_ids"];
  if (toolName === "chatwork/update_room_members") return ["room_id", "members_admin_ids"];
  if (toolName === "chatwork/get_room") return ["room_id"];
  if (toolName === "chatwork/list_room_members") return ["room_id"];
  if (toolName === "chatwork/list_messages") return ["room_id"];
  if (toolName === "chatwork/get_message") return ["room_id", "message_id"];
  if (toolName === "chatwork/send_message") return ["room_id", "body"];
  if (toolName === "chatwork/list_room_tasks") return ["room_id"];
  if (toolName === "chatwork/get_room_task") return ["room_id", "task_id"];
  if (toolName === "chatwork/create_room_task") return ["room_id", "body", "to_ids"];
  if (toolName === "chatwork/list_room_files") return ["room_id"];
  if (toolName === "chatwork/get_room_file") return ["room_id", "file_id"];
  if (toolName === "railway/graphql") return ["query"];
  if (toolName === "google_maps/geocode") return ["address"];
  if (toolName === "google_maps/reverse_geocode") return [];
  if (toolName === "google_maps/place_search") return ["query"];
  if (toolName === "google_maps/place_details") return ["place_id"];
  if (toolName === "google_maps/directions") return ["origin", "destination"];
  if (toolName === "google_maps/distance_matrix") return ["origins", "destinations"];
  if (toolName === "resend/send_email") return ["from", "to", "subject"];
  if (toolName === "resend/get_email") return ["email_id"];
  if (toolName === "resend/get_domain") return ["domain_id"];
  if (toolName === "slack/get_channel") return ["channel"];
  if (toolName === "slack/list_messages") return ["channel"];
  if (toolName === "slack/get_thread") return ["channel", "ts"];
  if (toolName === "slack/post_message") return ["channel"];
  if (toolName === "slack/update_message") return ["channel", "ts"];
  if (toolName === "slack/create_channel") return ["name"];
  if (toolName === "slack/invite_members") return ["channel", "users"];
  if (toolName === "slack/open_group_dm") return ["users"];
  if (toolName === "slack/invite_shared") return ["channel"];
  if (toolName === "slack/get_user") return ["user"];
  if (toolName === "freee/list_deals") return ["company_id"];
  if (toolName === "freee/get_deal") return ["company_id", "deal_id"];
  if (toolName === "freee/create_deal") return ["company_id", "issue_date", "type"];
  if (toolName === "freee/list_account_items") return ["company_id"];
  if (toolName === "freee/list_partners") return ["company_id"];
  if (toolName === "freee/create_partner") return ["company_id", "name"];
  if (toolName === "freee/trial_pl") return ["company_id"];
  if (toolName === "freee/trial_bs") return ["company_id"];
  if (toolName === "moneyforward/accounting_request") return ["path"];
  if (toolName === "moneyforward/accounting_get_journal") return ["journal_id"];
  if (toolName === "reddit/get_subreddit") return ["subreddit"];
  if (toolName === "reddit/list_posts") return ["subreddit"];
  if (toolName === "reddit/search") return ["query"];
  if (toolName === "reddit/get_comments") return ["article"];
  if (toolName === "reddit/submit_post") return ["subreddit", "title"];
  if (toolName === "reddit/submit_comment") return ["parent", "text"];
  if (toolName === "reddit/vote") return ["id"];
  if (toolName === "x/get_user") return ["username"];
  if (toolName === "x/get_user_tweets") return ["user_id"];
  if (toolName === "x/search_recent") return ["query"];
  if (toolName === "x/get_tweet") return ["id"];
  if (toolName === "x/post_tweet") return ["text"];
  if (toolName === "x/delete_tweet") return ["id"];
  if (toolName === "discord/get_guild") return ["guild_id"];
  if (toolName === "discord/list_channels") return ["guild_id"];
  if (toolName === "discord/get_channel") return ["channel_id"];
  if (toolName === "discord/list_messages") return ["channel_id"];
  if (toolName === "discord/get_message") return ["channel_id", "message_id"];
  if (toolName === "discord/send_message") return ["channel_id"];
  if (toolName === "discord/edit_message") return ["channel_id", "message_id"];
  if (toolName === "discord/delete_message") return ["channel_id", "message_id"];
  if (toolName === "discord/list_members") return ["guild_id"];
  if (toolName === "discord/get_user") return ["user_id"];
  if (toolName === "line/get_profile") return ["user_id"];
  if (toolName === "line/push_message") return ["to"];
  if (toolName === "line/reply_message") return ["reply_token"];
  if (toolName === "line/multicast") return ["to"];
  if (toolName === "line/get_group_summary") return ["group_id"];
  if (toolName === "line/get_group_member_count") return ["group_id"];
  if (toolName === "line/get_group_member_profile") return ["group_id", "user_id"];
  if (toolName === "facebook_messenger/get_user_profile") return ["psid"];
  if (toolName === "facebook_messenger/get_conversation_messages") return ["conversation_id"];
  if (toolName === "facebook_messenger/send_message") return ["recipient_id"];
  if (toolName === "facebook_messenger/send_sender_action") return ["recipient_id", "sender_action"];
  if (toolName === "airtable/list_tables") return ["base_id"];
  if (toolName === "airtable/list_records") return ["base_id", "table"];
  if (toolName === "airtable/get_record") return ["base_id", "table", "record_id"];
  if (toolName === "airtable/create_record") return ["base_id", "table"];
  if (toolName === "airtable/update_record") return ["base_id", "table", "record_id", "fields"];
  if (toolName === "airtable/delete_record") return ["base_id", "table", "record_id"];
  if (toolName === "linear/get_issue") return ["id"];
  if (toolName === "linear/search_issues") return ["query"];
  if (toolName === "linear/create_issue") return ["team_id", "title"];
  if (toolName === "linear/update_issue") return ["id"];
  if (toolName === "sendgrid/send_email") return ["from", "to", "subject"];
  if (toolName === "sendgrid/get_template") return ["template_id"];
  if (toolName === "sendgrid/get_stats") return ["start_date"];
  if (toolName === "vercel/get_project") return ["project_id"];
  if (toolName === "vercel/get_deployment") return ["deployment_id"];
  if (toolName === "stripe/get_customer") return ["customer_id"];
  if (toolName === "stripe/create_payment_intent") return ["amount", "currency"];
  if (toolName === "webflow/get_site") return ["site_id"];
  if (toolName === "webflow/list_collections") return ["site_id"];
  if (toolName === "webflow/list_items") return ["collection_id"];
  if (toolName === "webflow/create_item") return ["collection_id", "field_data"];
  if (toolName === "webflow/publish_site") return ["site_id"];
  if (toolName === "intercom/get_contact") return ["contact_id"];
  if (toolName === "intercom/search_contacts") return ["query"];
  if (toolName === "intercom/reply_conversation") return ["conversation_id", "admin_id", "body"];
  if (toolName === "customerio/send_transactional") return ["to"];
  if (toolName === "customerio/get_campaign") return ["campaign_id"];
  if (toolName === "customerio/get_campaign_metrics") return ["campaign_id"];
  if (toolName === "customerio/get_customer") return ["customer_id"];
  if (toolName === "mailchimp/get_list") return ["list_id"];
  if (toolName === "mailchimp/list_members") return ["list_id"];
  if (toolName === "mailchimp/add_member") return ["list_id", "email_address"];
  if (toolName === "zendesk/get_ticket") return ["ticket_id"];
  if (toolName === "zendesk/create_ticket") return ["subject", "body"];
  if (toolName === "zendesk/update_ticket") return ["ticket_id"];
  if (toolName === "zendesk/add_comment") return ["ticket_id", "body"];
  if (toolName === "zendesk/search") return ["query"];
  if (toolName === "wordpress/get_post") return ["post_id"];
  if (toolName === "wordpress/create_post") return ["title"];
  if (toolName === "wordpress/update_post") return ["post_id"];
  if (toolName === "shopify/get_product") return ["product_id"];
  if (toolName === "shopify/create_product") return ["title"];
  if (toolName === "shopify/get_order") return ["order_id"];
  if (toolName === "jira/search") return ["jql"];
  if (toolName === "jira/get_issue") return ["issue_key"];
  if (toolName === "jira/create_issue") return ["project_key", "summary", "issue_type"];
  if (toolName === "jira/update_issue") return ["issue_key", "fields"];
  if (toolName === "jira/add_comment") return ["issue_key", "body"];
  if (toolName === "jira/transition_issue") return ["issue_key", "transition_id"];
  if (toolName === "salesforce/query") return ["soql"];
  if (toolName === "salesforce/search") return ["sosl"];
  if (toolName === "salesforce/get_record") return ["sobject", "record_id"];
  if (toolName === "salesforce/create_record") return ["sobject", "fields"];
  if (toolName === "salesforce/update_record") return ["sobject", "record_id", "fields"];
  if (toolName === "salesforce/delete_record") return ["sobject", "record_id"];
  if (toolName === "linkedin_ads/get_ad_account") return ["account_id"];
  if (toolName === "linkedin_ads/list_campaigns") return ["account_id"];
  if (toolName === "linkedin_ads/get_campaign") return ["campaign_id"];
  if (toolName === "linkedin_ads/get_analytics") return ["params"];
  if (toolName === "tiktok_ads/get_advertiser_info") return ["advertiser_ids"];
  if (toolName === "tiktok_ads/list_campaigns") return ["advertiser_id"];
  if (toolName === "tiktok_ads/list_adgroups") return ["advertiser_id"];
  if (toolName === "tiktok_ads/list_ads") return ["advertiser_id"];
  if (toolName === "tiktok_ads/get_report") return ["advertiser_id", "params"];
  if (toolName === "aws/s3_list_objects") return ["bucket"];
  if (toolName === "snowflake/execute_statement") return ["statement"];
  if (toolName === "snowflake/get_statement") return ["statement_handle"];
  if (toolName === "snowflake/cancel_statement") return ["statement_handle"];
  if (toolName === "google_calendar/list_events") return ["calendar_id"];
  if (toolName === "google_calendar/get_event") return ["calendar_id", "event_id"];
  if (toolName === "google_calendar/create_event") return ["calendar_id", "start", "end"];
  if (toolName === "google_calendar/update_event") return ["calendar_id", "event_id"];
  if (toolName === "google_calendar/delete_event") return ["calendar_id", "event_id"];
  if (toolName === "google_sheets/get_spreadsheet") return ["spreadsheet_id"];
  if (toolName === "google_sheets/get_values") return ["spreadsheet_id", "range"];
  if (toolName === "google_sheets/batch_get_values") return ["spreadsheet_id", "ranges"];
  if (toolName === "google_sheets/update_values") return ["spreadsheet_id", "range", "values"];
  if (toolName === "google_sheets/append_values") return ["spreadsheet_id", "range", "values"];
  if (toolName === "google_sheets/create_spreadsheet") return ["title"];
  if (toolName === "google_tag_manager/list_containers") return ["account_id"];
  if (toolName === "google_tag_manager/get_container") return ["account_id", "container_id"];
  if (toolName === "google_tag_manager/list_workspaces") return ["account_id", "container_id"];
  if (toolName === "google_tag_manager/list_tags") return ["account_id", "container_id", "workspace_id"];
  if (toolName === "google_tag_manager/create_tag") return ["account_id", "container_id", "workspace_id", "tag"];
  if (toolName === "google_tag_manager/create_version") return ["account_id", "container_id", "workspace_id"];
  if (toolName === "google_tag_manager/publish_version") return ["account_id", "container_id", "version_id"];
  if (toolName === "google_cloud/get_project") return ["project_id"];
  if (toolName === "google_cloud/list_services") return ["project_id"];
  if (toolName === "google_cloud/list_log_entries") return ["project_id"];
  if (toolName === "google_cloud/get_billing_account") return ["billing_account_id"];
  if (toolName === "google_cloud/list_billing_account_projects") return ["billing_account_id"];
  if (toolName === "google_cloud/get_project_billing_info") return ["project_id"];
  if (toolName === "google_cloud/list_skus") return ["service_id"];
  if (toolName === "bigquery/list_datasets") return ["project_id"];
  if (toolName === "bigquery/list_tables") return ["project_id", "dataset_id"];
  if (toolName === "bigquery/get_table") return ["project_id", "dataset_id", "table_id"];
  if (toolName === "bigquery/query") return ["project_id", "query"];
  if (toolName === "bigquery/get_job") return ["project_id", "job_id"];
  if (toolName === "google_admin/get_user") return ["user_key"];
  if (toolName === "google_admin/create_user") return ["primaryEmail", "name", "password"];
  if (toolName === "google_admin/update_user") return ["user_key"];
  if (toolName === "google_admin/delete_user") return ["user_key"];
  if (toolName === "google_admin/get_group") return ["group_key"];
  if (toolName === "google_admin/create_group") return ["email"];
  if (toolName === "google_admin/update_group") return ["group_key"];
  if (toolName === "google_admin/delete_group") return ["group_key"];
  if (toolName === "google_admin/list_members") return ["group_key"];
  if (toolName === "google_admin/add_member") return ["group_key", "email"];
  if (toolName === "google_admin/update_member") return ["group_key", "member_key"];
  if (toolName === "google_admin/remove_member") return ["group_key", "member_key"];
  if (toolName === "google_admin/get_org_unit") return ["org_unit_path"];
  if (toolName === "google_admin/create_org_unit") return ["name", "parentOrgUnitPath"];
  if (toolName === "google_admin/update_org_unit") return ["org_unit_path"];
  if (toolName === "google_admin/delete_org_unit") return ["org_unit_path"];
  if (toolName === "zoom/get_meeting_recordings") return ["meeting_id"];
  if (toolName === "zoom/get_meeting") return ["meeting_id"];
  if (toolName === "zoom/create_meeting") return ["topic"];
  if (toolName === "zoom/get_meeting_participants") return ["meeting_id"];
  return [];
}

async function getSkillContent() {
  const [markdown, info] = await Promise.all([
    readFile(SKILL_URL, "utf8"),
    stat(SKILL_URL),
  ]);
  return {
    markdown,
    metadata: {
      format: "markdown",
      source: "docs/skill.md",
      updated_at: info.mtime.toISOString(),
      commit_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || null,
      server_version: "0.1.0",
    },
  };
}

function getProviderMetadata(includeTools = true) {
  const providers = Object.values(PROVIDERS)
    .filter((p) => p.implemented !== false)
    .map((p) => ({
      key: p.key,
      label: p.label,
      auth_types: p.authTypes,
      help_text: p.helpText,
      token_url: p.tokenUrl ?? null,
      oauth_setup_url: p.oauthSetupUrl ?? null,
      oauth_app_owner: p.authTypes.includes("oauth") ? (p.oauthAppOwner ?? "workspace") : null,
      oauth_client_auth_method: p.authTypes.includes("oauth") ? (p.oauthClientAuthMethod ?? "CLIENT_SECRET_POST") : null,
      oauth_scopes: p.oauthScopes ?? [],
      oauth_optional_scopes: p.oauthOptionalScopes ?? [],
      server_credential: p.serverCredentialEnv
        ? {
            label: p.serverCredentialLabel ?? null,
            env: p.serverCredentialEnv,
            url: p.serverCredentialUrl ?? null,
          }
        : null,
      ...(includeTools ? { tools: p.tools } : {}),
    }));
  return {
    providers,
    metadata: {
      count: providers.length,
      tool_count_including_system: 1 + SYSTEM_TOOLS.length + Object.values(PROVIDERS).reduce((sum, p) => p.implemented === false ? sum : sum + p.tools.length, 0),
      updated_at: new Date().toISOString(),
      commit_sha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || null,
      server_version: "0.1.0",
    },
  };
}

/**
 * Route a (provider, tool) call to its connector. Extracted so both the normal
 * tools/call path and grantry/delegate execute through exactly the same code.
 * `conn` carries the optional provider-level server credential (e.g. Google Ads
 * developer token).
 */
async function dispatchProviderTool(
  provider: string,
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  conn: { encryptedServerCredential: string | null },
): Promise<any> {
  if (toolName === `${provider}/request`) {
    const providerDef = PROVIDERS[provider];
    if (!providerDef) throw new Error(`provider not implemented: ${provider}`);
    return callGenericProviderRequest({ provider: providerDef, toolName, requestArgs: args, credential: token });
  }
  if (toolName === `${provider}/check_connection`) {
    const providerDef = PROVIDERS[provider];
    if (!providerDef) throw new Error(`provider not implemented: ${provider}`);
    return callGenericCheckConnection({ provider: providerDef, credential: token });
  }
  if (toolName === `${provider}/list_capabilities`) {
    const providerDef = PROVIDERS[provider];
    if (!providerDef) throw new Error(`provider not implemented: ${provider}`);
    return callGenericListCapabilities({ provider: providerDef });
  }
  if (provider === "notion") return callNotionTool(toolName, args, token);
  if (provider === "github") return callGitHubTool(toolName, args, token);
  if (provider === "cloudflare") return callCloudflareTool(toolName, args, token);
  if (provider === "clarity") return callClarityTool(toolName, args, token);
  if (provider === "google_drive") return callGoogleDriveTool(toolName, args, token);
  if (provider === "google_gsc") return callGoogleGscTool(toolName, args, token);
  if (provider === "google_analytics") return callGoogleAnalyticsTool(toolName, args, token);
  if (provider === "google_ads") return callGoogleAdsTool(toolName, args, token, conn.encryptedServerCredential ? decrypt(conn.encryptedServerCredential) : null);
  if (provider === "yahoo_ads") return callYahooAdsTool(toolName, args, token);
  if (provider === "meta_ads") return callMetaAdsTool(toolName, args, token);
  if (provider === "hubspot") return callHubSpotTool(toolName, args, token);
  if (provider === "gmail") return callGmailTool(toolName, args, token);
  if (provider === "youtube") return callYouTubeTool(toolName, args, token);
  if (provider === "attio") return callAttioTool(toolName, args, token);
  if (provider === "clay") return callClayTool(toolName, args, token);
  if (provider === "heyreach") return callHeyReachTool(toolName, args, token);
  if (provider === "chatwork") return callChatworkTool(toolName, args, token);
  if (provider === "railway") return callRailwayTool(toolName, args, token);
  if (provider === "google_maps") return callGoogleMapsTool(toolName, args, token);
  if (provider === "resend") return callResendTool(toolName, args, token);
  if (provider === "slack") return callSlackTool(toolName, args, token);
  if (provider === "freee") return callFreeeTool(toolName, args, token);
  if (provider === "moneyforward") return callMoneyForwardTool(toolName, args, token);
  if (provider === "reddit") return callRedditTool(toolName, args, token);
  if (provider === "zoom") return callZoomTool(toolName, args, token);
  if (provider === "x") return callXTool(toolName, args, token);
  if (provider === "discord") return callDiscordTool(toolName, args, token);
  if (provider === "line") return callLineTool(toolName, args, token);
  if (provider === "facebook_messenger") return callFacebookMessengerTool(toolName, args, token);
  if (provider === "airtable") return callAirtableTool(toolName, args, token);
  if (provider === "linear") return callLinearTool(toolName, args, token);
  if (provider === "sendgrid") return callSendGridTool(toolName, args, token);
  if (provider === "vercel") return callVercelTool(toolName, args, token);
  if (provider === "stripe") return callStripeTool(toolName, args, token);
  if (provider === "webflow") return callWebflowTool(toolName, args, token);
  if (provider === "intercom") return callIntercomTool(toolName, args, token);
  if (provider === "customerio") return callCustomerioTool(toolName, args, token);
  if (provider === "mailchimp") return callMailchimpTool(toolName, args, token);
  if (provider === "zendesk") return callZendeskTool(toolName, args, token);
  if (provider === "wordpress") return callWordpressTool(toolName, args, token);
  if (provider === "shopify") return callShopifyTool(toolName, args, token);
  if (provider === "jira") return callJiraTool(toolName, args, token);
  if (provider === "salesforce") return callSalesforceTool(toolName, args, token);
  if (provider === "linkedin_ads") return callLinkedinAdsTool(toolName, args, token);
  if (provider === "tiktok_ads") return callTiktokAdsTool(toolName, args, token);
  if (provider === "microsoft_ads") return callMicrosoftAdsTool(toolName, args, token);
  if (provider === "aws") return callAwsTool(toolName, args, token);
  if (provider === "snowflake") return callSnowflakeTool(toolName, args, token);
  if (provider === "google_calendar") return callGoogleCalendarTool(toolName, args, token);
  if (provider === "google_sheets") return callGoogleSheetsTool(toolName, args, token);
  if (provider === "google_tag_manager") return callGoogleTagManagerTool(toolName, args, token);
  if (provider === "google_cloud") return callGoogleCloudTool(toolName, args, token);
  if (provider === "bigquery") return callBigQueryTool(toolName, args, token);
  if (provider === "google_admin") return callGoogleAdminTool(toolName, args, token);
  throw new Error(`no dispatcher for provider: ${provider}`);
}

type SystemToolContext = { agentId: string; ownerId: string; workspaceId: string | null };

async function callSystemTool(toolName: string, args: Record<string, unknown>, ctx?: SystemToolContext) {
  if (toolName === "grantry/get_skill") {
    const skill = await getSkillContent();
    return {
      content: [{ type: "text", text: skill.markdown }],
      structuredContent: skill,
      isError: false,
    };
  }
  if (toolName === "grantry/get_providers") {
    const includeTools = args.include_tools !== false && args.includeTools !== false;
    const providers = getProviderMetadata(includeTools);
    // When called with an agent token, surface the scopes this token can
    // actually reach so the caller can discover them in the same round-trip
    // (full detail is in grantry/list_scopes). Anonymous callers get no scopes.
    if (ctx) {
      const conns = await connectionsForAgent(ctx.agentId);
      (providers.metadata as Record<string, unknown>).scopes = Array.from(new Set(conns.map((c) => c.scope))).sort();
    }
    return {
      content: [{ type: "text", text: JSON.stringify(providers, null, 2) }],
      structuredContent: providers,
      isError: false,
    };
  }
  if (toolName === "grantry/list_scopes") {
    if (!ctx) throw new Error("list_scopes requires authentication");
    const conns = await connectionsForAgent(ctx.agentId);
    const byScope = new Map<string, { provider: string; auth_type: string; connection_id: string; label: string; tools: string[] }[]>();
    for (const conn of conns) {
      if (!byScope.has(conn.scope)) byScope.set(conn.scope, []);
      byScope.get(conn.scope)!.push({
        provider: conn.provider,
        auth_type: conn.authType,
        connection_id: conn.id,
        label: conn.label,
        tools: conn.tools,
      });
    }
    const scopes = Array.from(byScope.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([scope, connections]) => ({
        scope,
        providers: Array.from(new Set(connections.map((c) => c.provider))).sort(),
        connections,
      }));
    const payload = { scopes, count: scopes.length };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: false };
  }
  if (toolName === "grantry/find_agent") {
    if (!ctx) throw new Error("find_agent requires authentication");
    const task = String(args.task ?? "");
    if (!task.trim()) throw new Error("find_agent requires a 'task' description");
    const scope = args.scope === undefined || args.scope === null || args.scope === "" ? undefined : String(args.scope);
    const guessedTools = guessToolsFromTask(task);
    // Gather every capable (agent, connection) match across the guessed tools.
    const all: Awaited<ReturnType<typeof findCapableAgents>> = [];
    for (const tool of guessedTools) {
      all.push(...await findCapableAgents({ tool, scope, workspaceId: ctx.workspaceId, ownerId: ctx.ownerId }));
    }
    // Tokens the task actually carries — used to score charter and, crucially,
    // the *target*: which connection's scope / label / project the task names.
    const taskWords = new Set(
      task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2),
    );
    const overlap = (text: string | null, cap: number): number => {
      if (!text || !taskWords.size) return 0;
      const tw = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      if (!tw.length) return 0;
      const hits = new Set(tw.filter((w) => taskWords.has(w))).size;
      return Math.min(cap, hits * 0.1);
    };
    // Dedupe by *connection*, not agent (issue #47): ~10 agents sharing the
    // same connection grants must not fill the result cap and hide the single
    // agent holding the connection that actually reaches the target. Key on (tool, scope, label);
    // keep the strongest representative agent per distinct connection.
    // The structural signal (credential freshness, explicit scope, single
    // connection) saturates at 0.95, so it crowns every duplicate equally. Give
    // it only half the range and let target/charter overlap fill the rest — that
    // headroom is what lets a real target match reorder candidates and produces
    // a confidence that varies instead of a constant.
    type Match = (typeof all)[number] & { targetScore: number; charterScore: number };
    const byConn = new Map<string, Match>();
    const rank = (x: Match) => 0.5 * x.confidence + x.targetScore + x.charterScore;
    for (const m of all) {
      const key = `${m.tool}::${m.connection.scope}::${m.connection.label}`;
      const enriched: Match = {
        ...m,
        // Scope/label/project overlap is the issue's core fix: a task naming
        // "production" / "agent-oauth" must rank the connection that reaches it.
        // Provider is deliberately excluded — every same-provider candidate
        // would match it equally, which discriminates nothing and would mask
        // the no-match penalty below.
        targetScore: overlap(`${m.connection.scope} ${m.connection.label}`, 0.3),
        charterScore: overlap(m.charter, 0.15),
      };
      const prev = byConn.get(key);
      if (!prev || rank(enriched) > rank(prev)) byConn.set(key, enriched);
    }
    // Target-aware confidence: a flat 0.95 overstates certainty on wrong
    // answers. When the task names a concrete target and some connection's
    // scope/label/project matches it, candidates that match *nothing* are the
    // likely-wrong ones — penalize them so the right connection rises.
    const matches = Array.from(byConn.values());
    const maxTarget = matches.reduce((mx, c) => Math.max(mx, c.targetScore), 0);
    const candidates = matches
      .map((m) => {
        let confidence = 0.5 * m.confidence + m.targetScore + m.charterScore;
        if (maxTarget > 0 && m.targetScore === 0) confidence -= 0.25;
        confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
        const { targetScore: _t, charterScore: _c, ...rest } = m;
        return { ...rest, confidence };
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);
    // Scope-name lane: find_agent matches tasks to *peer agents*, so a task that
    // is really just a tenant-scope name (e.g. "dev-manager") used to come back
    // empty — a false negative that reads as "no such scope". Surface any scopes
    // this token can reach whose name appears in the task, and always point at
    // list_scopes when nothing matched, so absence is never mistaken for proof.
    const accessibleScopes = Array.from(new Set((await connectionsForAgent(ctx.agentId)).map((c) => c.scope)));
    const taskLc = task.toLowerCase();
    const scopeMatches = accessibleScopes.filter((s) => taskLc.includes(s.toLowerCase())).sort();
    const hint = candidates.length
      ? undefined
      : `No peer agent matched this task. If you were after a tenant scope, call grantry_list_scopes — accessible scopes: ${accessibleScopes.sort().join(", ") || "(none)"}.`;
    const payload = { task, guessedTools, candidates, scopeMatches, hint };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: false };
  }
  if (toolName === "grantry/route") {
    if (!ctx) throw new Error("route requires authentication");
    const tool = normalizeToolName(args.tool);
    if (!tool || !tool.includes("/")) throw new Error("route requires a 'tool' like 'railway/graphql'");
    const scope = args.scope === undefined || args.scope === null || args.scope === "" ? undefined : String(args.scope);
    const candidates = await findCapableAgents({ tool, scope, workspaceId: ctx.workspaceId, ownerId: ctx.ownerId });
    const payload = { tool, scope: scope ?? null, candidates };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: false };
  }
  throw new Error(`Unknown system tool: ${toolName}`);
}

// Keys whose values never belong in the audit log in plaintext: file payloads,
// message bodies, and anything credential-shaped. Length/shape is kept so the
// log still shows *what* was sent, just not the content.
const SENSITIVE_AUDIT_KEYS = new Set([
  "files", "content", "body", "text", "html", "credential", "token", "password", "secret", "api_key", "apiKey",
]);
const TOKEN_LIKE = /^(gh[pousr]_|github_pat_|ntn_|secret_|re_|sk-|ya29\.|Bearer\s)/;

function maskAuditArgs(args: Record<string, unknown>): string {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (SENSITIVE_AUDIT_KEYS.has(key)) {
      masked[key] =
        typeof value === "string" ? `<redacted ${value.length} chars>`
        : Array.isArray(value) ? `<redacted ${value.length} items>`
        : value && typeof value === "object" ? `<redacted ${Object.keys(value).length} keys>`
        : "<redacted>";
    } else if (typeof value === "string" && TOKEN_LIKE.test(value)) {
      masked[key] = "<redacted token-like value>";
    } else if (typeof value === "string" && value.length > 300) {
      masked[key] = `${value.slice(0, 300)}…<+${value.length - 300} chars>`;
    } else {
      masked[key] = value;
    }
  }
  return JSON.stringify(masked).slice(0, 4000);
}

// Per-agent sliding-window rate limit for tools/call. In-memory: fine for a
// single instance; the goal is abuse damping for a leaked token, not quota
// accounting. Set MCP_RATE_LIMIT_PER_MINUTE=0 to disable.
const RATE_LIMIT_PER_MINUTE = Number(process.env.MCP_RATE_LIMIT_PER_MINUTE ?? 120);
const rateWindows = new Map<string, number[]>();

function rateLimitExceeded(agentId: string): boolean {
  if (!RATE_LIMIT_PER_MINUTE || !Number.isFinite(RATE_LIMIT_PER_MINUTE)) return false;
  const now = Date.now();
  const cutoff = now - 60_000;
  let window = rateWindows.get(agentId);
  if (!window) {
    window = [];
    rateWindows.set(agentId, window);
  }
  while (window.length && window[0] < cutoff) window.shift();
  if (window.length >= RATE_LIMIT_PER_MINUTE) return true;
  window.push(now);
  return false;
}

/**
 * Tools advertised via tools/list, scoped to the calling agent.
 * - `ping` is always available (liveness, no policy).
 * - When `connections` is null (unauthenticated request), only `ping` is returned.
 * - Tools with an enabled, policy-usable connection are listed for direct calls.
 * - Tools reachable only via delegation (`delegatable`: a capable peer under the
 *   same owner holds them) are also listed, so the documented redeem flow — mint
 *   a grant_token with grantry_delegate, then call the tool normally with it — has
 *   a discoverable entrypoint. Calling such a tool without a grant_token is denied
 *   (with a capable-peer signpost); execution is re-authorized at redemption.
 */
function buildToolList(
  connections: Awaited<ReturnType<typeof connectionsForAgent>> | null,
  delegatable: Map<string, Set<string>> = new Map(),
) {
  const tools: any[] = [
    { name: "ping", description: "Liveness check", inputSchema: { type: "object", properties: {} } },
    {
      name: publicToolName("grantry/get_skill"),
      description: "grantry: latest MCP skill markdown and usage instructions",
      inputSchema: {
        type: "object",
        properties: toolSpecificInputProperties("grantry/get_skill"),
        required: [],
      },
    },
    {
      name: publicToolName("grantry/get_providers"),
      description: "grantry: implemented providers, auth types, and tool names",
      inputSchema: {
        type: "object",
        properties: toolSpecificInputProperties("grantry/get_providers"),
        required: [],
      },
    },
  ];
  if (!connections) return tools;

  // Capability discovery tools — only for authenticated agents, since they
  // search the caller's workspace (docs/agent-orchestration.md).
  tools.push(
    {
      name: publicToolName("grantry/find_agent"),
      description: "grantry: find which agent in your workspace can do a described task. Candidates are distinct *connections* (not duplicate agents), ranked by how well the task names the connection's scope/label/project plus each agent's `charter`. Confidence reflects target match — a low score means the connection probably doesn't reach what the task describes.",
      inputSchema: {
        type: "object",
        properties: toolSpecificInputProperties("grantry/find_agent"),
        required: ["task"],
      },
    },
    {
      name: publicToolName("grantry/route"),
      description: "grantry: list agents in your workspace that can call a specific tool/scope",
      inputSchema: {
        type: "object",
        properties: toolSpecificInputProperties("grantry/route"),
        required: ["tool"],
      },
    },
    {
      name: publicToolName("grantry/list_scopes"),
      description: "grantry: list the tenant scopes this agent token can access, each with its connected providers and the exact `scope` strings + tools to pass to tools/call. Call this first to discover what you can reach instead of guessing scope names.",
      inputSchema: {
        type: "object",
        properties: toolSpecificInputProperties("grantry/list_scopes"),
        required: [],
      },
    },
    {
      name: publicToolName("grantry/delegate"),
      description: "grantry: mint a single-use grant token to run one tool/scope via a capable peer agent (same owner). grantry does not execute — present the returned grant_token on a normal tools/call",
      inputSchema: {
        type: "object",
        properties: toolSpecificInputProperties("grantry/delegate"),
        required: ["agent_id", "tool", "scope"],
      },
    },
  );

  const scopesByTool = new Map<string, Set<string>>();
  const authTypesByTool = new Map<string, Set<string>>();
  const connectionIdsByTool = new Map<string, Set<string>>();
  for (const conn of connections) {
    for (const tool of conn.tools) {
      if (!scopesByTool.has(tool)) scopesByTool.set(tool, new Set());
      if (!authTypesByTool.has(tool)) authTypesByTool.set(tool, new Set());
      if (!connectionIdsByTool.has(tool)) connectionIdsByTool.set(tool, new Set());
      scopesByTool.get(tool)!.add(conn.scope);
      authTypesByTool.get(tool)!.add(conn.authType);
      connectionIdsByTool.get(tool)!.add(conn.id);
    }
  }

  for (const p of Object.values(PROVIDERS)) {
    if (p.implemented === false) continue;
    for (const toolName of p.tools) {
      const directScopes = scopesByTool.get(toolName) ?? new Set<string>();
      // Scopes only reachable by delegation (drop any the agent can call directly).
      const delegScopes = new Set<string>();
      for (const s of delegatable.get(toolName) ?? []) {
        if (!directScopes.has(s)) delegScopes.add(s);
      }
      const scopes = Array.from(new Set([...directScopes, ...delegScopes])).sort();
      if (!scopes.length) continue;
      const authTypes = Array.from(authTypesByTool.get(toolName) ?? []).sort();
      const connectionIds = Array.from(connectionIdsByTool.get(toolName) ?? []).sort();
      const action = toolName.split("/")[1]?.replace(/_/g, " ");
      // Flag tools that are *only* reachable by delegation, so the model knows a
      // grant_token is required rather than a direct call.
      const delegationOnly = directScopes.size === 0;
      const description = delegationOnly
        ? `${p.label}: ${action} (delegated — mint a grant_token via grantry_delegate, then call with that grant_token + scope)`
        : `${p.label}: ${action}`;
      tools.push({
        name: publicToolName(toolName),
        description,
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", enum: scopes, description: "Tenant scope. Use one of the scopes exposed for this agent token." },
            auth_type: { type: "string", enum: authTypes, description: "Optional auth type disambiguator." },
            connection_id: { type: "string", enum: connectionIds, description: "Optional connection id disambiguator." },
            grant_token: { type: "string", description: "One-time delegation grant from grantry_delegate, authorizing this exact tool+scope via a capable peer agent. Required for delegated scopes (those without a direct connection on this agent token)." },
            ...toolSpecificInputProperties(toolName),
          },
          required: ["scope", ...requiredToolSpecificArgs(toolName)],
        },
      });
    }
  }
  return tools;
}

/**
 * Resolve agent from Authorization: Bearer <token>. Two token styles:
 *  - gn_agt_*  — static agent token, sha256 looked up in Agent.hashedToken
 *  - otherwise — OAuth access token issued by the better-auth mcp plugin
 *    (claude.ai / Claude Desktop via dynamic client registration). The token
 *    maps to a user; OauthAgentGrant (user x client) picks which Agent the
 *    connector acts as. Permissions are evaluated from live connection grants
 *    per request, so dashboard changes apply immediately.
 */
async function resolveAgent(authHeader: string | null): Promise<{ id: string; name: string; enabled: boolean } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  if (!token) return null;

  if (token.startsWith("gn_agt_")) {
    // Look up by token hash (hashedToken is unique but not the @id, so use findFirst)
    const crypto = await import("node:crypto");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const agent = await prisma.agent.findFirst({ where: { hashedToken: tokenHash } });
    if (!agent || !agent.enabled) return null;
    if (agent.expiresAt && agent.expiresAt < new Date()) return null;
    return { id: agent.id, name: agent.name, enabled: agent.enabled };
  }

  return resolveOAuthAgent(token);
}

/** Resolve an MCP-plugin OAuth access token to the grantry Agent it acts as. */
async function resolveOAuthAgent(token: string): Promise<{ id: string; name: string; enabled: boolean } | null> {
  const accessToken = await prisma.oauthAccessToken
    .findUnique({ where: { accessToken: token } })
    .catch(() => null);
  if (!accessToken || !accessToken.userId) return null;
  if (accessToken.accessTokenExpiresAt && accessToken.accessTokenExpiresAt < new Date()) return null;

  // Explicit binding chosen at connect time wins; otherwise fall back to the
  // user's sole connectable agent so single-agent setups need no extra step.
  const grant = await prisma.oauthAgentGrant.findUnique({
    where: { userId_clientId: { userId: accessToken.userId, clientId: accessToken.clientId } },
  });
  let agent = grant
    ? await prisma.agent.findUnique({ where: { id: grant.agentId } })
    : null;
  if (!agent) {
    const candidates = await prisma.agent.findMany({
      where: {
        enabled: true,
        OR: [
          { ownerId: accessToken.userId },
          { assignments: { some: { userId: accessToken.userId } } },
        ],
      },
      take: 2,
    });
    if (candidates.length === 1) agent = candidates[0];
  }
  if (!agent || !agent.enabled) return null;
  if (agent.expiresAt && agent.expiresAt < new Date()) return null;

  // Re-verify on every request: unassignment / workspace removal must revoke
  // access immediately even though the OauthAgentGrant row still exists.
  if (!(await userMayUseAgent(accessToken.userId, agent))) return null;

  return { id: agent.id, name: agent.name, enabled: agent.enabled };
}

function prepareMcpSession(c: any, agent: { id: string } | null) {
  if (!agent) return { ok: true as const };

  cleanupExpiredMcpSessions();
  const now = Date.now();
  const requestedId = c.req.header("mcp-session-id") ?? c.req.header("Mcp-Session-Id") ?? "";
  if (requestedId) {
    const existing = mcpSessions.get(requestedId);
    if (!existing || existing.expiresAt <= now) {
      return { ok: false as const, status: 404, message: "Mcp-Session-Id is unknown or expired; retry without the header to create a new session" };
    }
    if (existing.agentId !== agent.id) {
      return { ok: false as const, status: 409, message: "Mcp-Session-Id belongs to a different agent token" };
    }
    existing.lastSeenAt = now;
    existing.expiresAt = now + MCP_SESSION_TTL_MS;
    c.header("Mcp-Session-Id", requestedId);
    return { ok: true as const };
  }

  const sessionId = randomUUID();
  mcpSessions.set(sessionId, {
    agentId: agent.id,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + MCP_SESSION_TTL_MS,
  });
  c.header("Mcp-Session-Id", sessionId);
  return { ok: true as const };
}

function safeJsonObject(s: string | null | undefined): Record<string, any> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function requiredScopesForTool(provider: string, toolName: string): string[] {
  const operations = PROVIDERS[provider]?.genericRequest?.operations ?? [];
  const required = new Set<string>();
  for (const op of operations) {
    if ((op.tools ?? []).includes(toolName)) {
      for (const scope of op.requiredScopes ?? []) required.add(scope);
    }
  }
  return Array.from(required);
}

function grantedScopesFromMetadata(raw: string | null | undefined): string[] {
  const meta = safeJsonObject(raw);
  const scopes = Array.isArray(meta.scopes) ? meta.scopes.map(String).filter(Boolean) : [];
  return Array.from(new Set(scopes));
}

function missingRequiredScopes(required: string[], granted: string[]) {
  const grantedSet = new Set(granted);
  return required.filter((scope) => !grantedSet.has(scope));
}

function probeMissingScopesFromMetadata(raw: string | null | undefined, requiredScopes: string[]): string[] {
  const requiredSet = new Set(requiredScopes);
  const meta = safeJsonObject(raw);
  const tests = Array.isArray(meta.capabilities?.smokeTests) ? meta.capabilities.smokeTests : [];
  const missing = new Set<string>();
  for (const test of tests) {
    const testRequired = Array.isArray(test.requiredScopes) ? test.requiredScopes.map(String) : [];
    if (!testRequired.some((scope: string) => requiredSet.has(scope))) continue;
    for (const scope of Array.isArray(test.missingScopes) ? test.missingScopes.map(String) : []) {
      if (requiredSet.has(scope)) missing.add(scope);
    }
  }
  return Array.from(missing);
}

function providerReauthUrl(provider: string, conn: { scope: string }, missingScopes: string[]) {
  const params = new URLSearchParams({ tenant: conn.scope, reauth: "1" });
  if (missingScopes.length) params.set("optional_scopes", missingScopes.join(","));
  return `/oauth/${provider}/start?${params.toString()}`;
}

function providerScopeDeniedPayload(args: {
  provider: string;
  toolName: string;
  authType: string;
  connectionId: string;
  scope: string;
  requiredScopes: string[];
  grantedScopes: string[];
  missingScopes: string[];
}) {
  return {
    code: "provider_scope_missing",
    provider: args.provider,
    tool: args.toolName,
    authType: args.authType,
    connectionId: args.connectionId,
    scope: args.scope,
    requiredScopes: args.requiredScopes,
    grantedScopes: args.grantedScopes,
    missingScopes: args.missingScopes,
    reauthUrl: providerReauthUrl(args.provider, { scope: args.scope }, args.missingScopes),
    message: `${args.provider} connection is missing required scope(s): ${args.missingScopes.join(", ")}`,
  };
}

async function assertProviderScopesBeforeDispatch(args: {
  provider: string;
  toolName: string;
  token: string;
  conn: {
    id: string;
    provider: string;
    authType: string;
    scope: string;
    credentialMetadata: string | null;
    credentialId: string | null;
  };
}) {
  const requiredScopes = requiredScopesForTool(args.provider, args.toolName);
  if (!requiredScopes.length) return null;

  let grantedScopes = grantedScopesFromMetadata(args.conn.credentialMetadata);
  if (args.conn.authType === "oauth") {
    let missing = missingRequiredScopes(requiredScopes, grantedScopes);
    if (missing.length) {
      const meta = await credentialMetadataForStorage(args.conn.provider, args.conn.authType, args.token);
      grantedScopes = grantedScopesFromMetadata(meta.credentialMetadata);
      missing = missingRequiredScopes(requiredScopes, grantedScopes);
      await prisma.connection.update({
        where: { id: args.conn.id },
        data: {
          credentialMetadata: meta.credentialMetadata,
          credentialValidatedAt: meta.credentialValidatedAt,
        },
      });
      if (args.conn.credentialId) {
        await prisma.providerCredential.update({
          where: { id: args.conn.credentialId },
          data: {
            credentialMetadata: meta.credentialMetadata,
            credentialValidatedAt: meta.credentialValidatedAt,
          },
        }).catch(() => {});
      }
    }
    missing = missingRequiredScopes(requiredScopes, grantedScopes);
    if (missing.length) {
      return providerScopeDeniedPayload({
        provider: args.provider,
        toolName: args.toolName,
        authType: args.conn.authType,
        connectionId: args.conn.id,
        scope: args.conn.scope,
        requiredScopes,
        grantedScopes,
        missingScopes: missing,
      });
    }
  }

  if (args.conn.authType !== "oauth") {
    let missing = probeMissingScopesFromMetadata(args.conn.credentialMetadata, requiredScopes);
    if (!missing.length) {
      const meta = await credentialMetadataForStorage(args.conn.provider, args.conn.authType, args.token);
      missing = probeMissingScopesFromMetadata(meta.credentialMetadata, requiredScopes);
      await prisma.connection.update({
        where: { id: args.conn.id },
        data: {
          credentialMetadata: meta.credentialMetadata,
          credentialValidatedAt: meta.credentialValidatedAt,
        },
      });
      if (args.conn.credentialId) {
        await prisma.providerCredential.update({
          where: { id: args.conn.credentialId },
          data: {
            credentialMetadata: meta.credentialMetadata,
            credentialValidatedAt: meta.credentialValidatedAt,
          },
        }).catch(() => {});
      }
    }
    if (missing.length) {
      return providerScopeDeniedPayload({
        provider: args.provider,
        toolName: args.toolName,
        authType: args.conn.authType,
        connectionId: args.conn.id,
        scope: args.conn.scope,
        requiredScopes,
        grantedScopes,
        missingScopes: missing,
      });
    }
  }

  return null;
}

function providerRequiresWorkspaceOAuthApp(provider: string) {
  const providerDef = PROVIDERS[provider];
  return Array.isArray(providerDef?.authTypes)
    && providerDef.authTypes.includes("oauth")
    && providerDef.oauthAppOwner === "workspace";
}

function oauthEnvClientConfig(provider: string) {
  const envPrefix = provider.toUpperCase();
  const legacyAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_ID", "GRANTRY_GITHUB_CLIENT_ID"],
    google_gsc: ["GOOGLE_CLIENT_ID"],
    google_analytics: ["GOOGLE_CLIENT_ID"],
    google_ads: ["GOOGLE_CLIENT_ID"],
    google_drive: ["GOOGLE_CLIENT_ID"],
    gmail: ["GOOGLE_CLIENT_ID"],
    youtube: ["GOOGLE_CLIENT_ID"],
    google_calendar: ["GOOGLE_CLIENT_ID"],
    google_sheets: ["GOOGLE_CLIENT_ID"],
    google_tag_manager: ["GOOGLE_CLIENT_ID"],
    google_cloud: ["GOOGLE_CLIENT_ID"],
    bigquery: ["GOOGLE_CLIENT_ID"],
    google_admin: ["GOOGLE_CLIENT_ID"],
    yahoo_ads: ["YAHOO_CLIENT_ID"],
  };
  const legacySecretAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_SECRET", "GRANTRY_GITHUB_CLIENT_SECRET"],
    google_gsc: ["GOOGLE_CLIENT_SECRET"],
    google_analytics: ["GOOGLE_CLIENT_SECRET"],
    google_ads: ["GOOGLE_CLIENT_SECRET"],
    google_drive: ["GOOGLE_CLIENT_SECRET"],
    gmail: ["GOOGLE_CLIENT_SECRET"],
    youtube: ["GOOGLE_CLIENT_SECRET"],
    google_calendar: ["GOOGLE_CLIENT_SECRET"],
    google_sheets: ["GOOGLE_CLIENT_SECRET"],
    google_tag_manager: ["GOOGLE_CLIENT_SECRET"],
    google_cloud: ["GOOGLE_CLIENT_SECRET"],
    bigquery: ["GOOGLE_CLIENT_SECRET"],
    google_admin: ["GOOGLE_CLIENT_SECRET"],
    yahoo_ads: ["YAHOO_CLIENT_SECRET"],
  };
  return {
    clientId: process.env[`${envPrefix}_CLIENT_ID`]
      || (legacyAliases[provider] || []).map((k) => process.env[k]).find(Boolean),
    clientSecret: process.env[`${envPrefix}_CLIENT_SECRET`]
      || (legacySecretAliases[provider] || []).map((k) => process.env[k]).find(Boolean),
    clientAuthMethod: process.env[`${envPrefix}_CLIENT_AUTH_METHOD`] || "CLIENT_SECRET_POST",
  };
}

async function oauthClientConfigForRefresh(provider: string, workspaceId: string | null | undefined) {
  if (workspaceId) {
    const credential = await prisma.providerCredential.findFirst({
      where: { workspaceId, provider, authType: "oauth_app", enabled: true },
      orderBy: { updatedAt: "desc" },
    });
    if (credential) {
      const meta = safeJsonObject(credential.credentialMetadata);
      const clientId = typeof meta.oauthClientId === "string" ? meta.oauthClientId.trim() : "";
      if (clientId) {
        return {
          clientId,
          clientSecret: decrypt(credential.encryptedCredential),
          clientAuthMethod: typeof meta.oauthClientAuthMethod === "string" ? meta.oauthClientAuthMethod : "CLIENT_SECRET_BASIC",
        };
      }
    }
  }
  if (providerRequiresWorkspaceOAuthApp(provider)) {
    return { clientId: "", clientSecret: "", clientAuthMethod: PROVIDERS[provider]?.oauthClientAuthMethod || "CLIENT_SECRET_POST" };
  }
  return oauthEnvClientConfig(provider);
}

async function refreshOAuthToken(provider: string, refreshToken: string, workspaceId?: string | null) {
  const providerDef = PROVIDERS[provider];
  if (!providerDef?.oauthTokenUrl) throw new Error(`OAuth refresh is not configured for provider: ${provider}`);

  const envPrefix = provider.toUpperCase();
  const { clientId, clientSecret, clientAuthMethod } = await oauthClientConfigForRefresh(provider, workspaceId);
  if (!clientId || !clientSecret) {
    if (providerRequiresWorkspaceOAuthApp(provider)) {
      throw new Error(`${provider} OAuth refresh credentials missing: configure this workspace's OAuth app credential`);
    }
    throw new Error(`${provider} OAuth refresh credentials missing: set ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET`);
  }

  // Some OAuth providers require HTTP Basic auth at the token endpoint rather
  // than client credentials in the body.
  const clientAuthMethodNormalized = String(clientAuthMethod || providerDef.oauthClientAuthMethod || "CLIENT_SECRET_POST").toUpperCase();
  const usesBasicAuth = clientAuthMethodNormalized === "CLIENT_SECRET_BASIC";
  const refreshBody = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (!usesBasicAuth) {
    refreshBody.set("client_secret", clientSecret);
  }
  const refreshHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (usesBasicAuth) {
    refreshHeaders.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  }
  if (provider === "reddit") {
    refreshHeaders["User-Agent"] = "grantry/1.0 (MCP connector)";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);
  try {
    const resp = await fetch(providerDef.oauthTokenUrl, {
      method: "POST",
      headers: refreshHeaders,
      body: refreshBody,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json: any = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!resp.ok || json.error || !json.access_token) {
      throw new Error(`${provider} OAuth refresh failed: ${resp.status} ${JSON.stringify(json).slice(0, 500)}`);
    }
    return json as { access_token: string; expires_in?: number; refresh_token?: string };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`${provider} OAuth refresh timed out after ${TOKEN_REFRESH_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function credentialForConnection(conn: {
  id: string;
  provider: string;
  encryptedCredential: string;
  encryptedServerCredential: string | null;
  credentialId: string | null;
  authType: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  workspaceId?: string | null;
}) {
  const shared = conn.credentialId
    ? await prisma.providerCredential.findUnique({ where: { id: conn.credentialId } })
    : null;
  const encryptedCredential = shared?.encryptedCredential ?? conn.encryptedCredential;

  // Service account (Domain-Wide Delegation): the stored credential is the SA key
  // + impersonated subject, not a bearer token. Mint a short-lived access token
  // for the provider's DWD scopes (cached in-process by google_dwd.ts).
  if (conn.authType === "service_account") {
    const cred = JSON.parse(decrypt(encryptedCredential)) as ServiceAccountCredential;
    const scopes = PROVIDERS[conn.provider]?.dwdScopes ?? [];
    return mintDwdAccessToken(conn.id, cred, scopes);
  }

  const refreshToken = shared?.refreshToken ?? conn.refreshToken;
  const accessTokenExpiresAt = shared?.accessTokenExpiresAt ?? conn.accessTokenExpiresAt;
  const currentToken = decrypt(encryptedCredential);
  if (!refreshToken || !accessTokenExpiresAt) return currentToken;
  if (accessTokenExpiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) return currentToken;

  console.log("[oauth] refreshing access token", {
    provider: conn.provider,
    connectionId: conn.id,
    expiresAt: accessTokenExpiresAt.toISOString(),
  });
  const refreshed = await refreshOAuthToken(conn.provider, decrypt(refreshToken), conn.workspaceId);
  const data = {
    encryptedCredential: encrypt(refreshed.access_token),
    accessTokenExpiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
    ...(await credentialMetadataForStorage(conn.provider, conn.authType, refreshed.access_token)),
    ...(refreshed.refresh_token ? { refreshToken: encrypt(refreshed.refresh_token) } : {}),
  };
  if (conn.credentialId) {
    await prisma.$transaction([
      prisma.providerCredential.update({ where: { id: conn.credentialId }, data }),
      prisma.connection.updateMany({ where: { credentialId: conn.credentialId }, data }),
    ]);
  } else {
    await prisma.connection.update({ where: { id: conn.id }, data });
  }
  return refreshed.access_token;
}

const handleMcpPost = async (c: any) => {
  const started = Date.now();
  const auth = c.req.header("authorization") ?? null;
  const agent = await resolveAgent(auth);
  const configuredScope = configuredMcpScope(c);
  const wsSlug = String(c.req.param("ws") ?? "").trim();
  c.header("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

  // MCP authorization spec: unauthenticated (or invalid-token) requests get
  // 401 + WWW-Authenticate pointing at the protected-resource metadata for
  // THIS resource URL (RFC 9728 path insertion — /mcp/w/<ws> gets its own).
  // This is what triggers the OAuth flow in remote clients like claude.ai
  // and Claude Desktop. Static gn_agt_ tokens authenticate as before.
  if (!agent) {
    const requestOrigin = new URL(c.req.url).origin;
    const origin = process.env.BETTER_AUTH_URL
      ? new URL(process.env.BETTER_AUTH_URL).origin
      : requestOrigin;
    const resourcePath = c.req.path; // full path: /mcp, /mcp/w/<ws>, /mcp/s/<scope>
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${resourcePath}"`,
    );
    return c.json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message:
          "Unauthorized: pass 'Authorization: Bearer gn_agt_...' or complete the OAuth flow advertised in WWW-Authenticate",
      },
    }, 401);
  }

  // Workspace-locked endpoint (/mcp/w/<slug>): the resolved agent must live
  // in that workspace. Lets one desktop hold parallel connectors for
  // different workspaces (client A / client B) without cross-talk.
  if (wsSlug) {
    const dbAgent = await prisma.agent.findUnique({
      where: { id: agent.id },
      select: { workspace: { select: { slug: true } } },
    });
    if (dbAgent?.workspace?.slug !== wsSlug) {
      return c.json({
        jsonrpc: "2.0", id: null,
        error: {
          code: -32003,
          message: `This endpoint is locked to workspace '${wsSlug}', but the authenticated agent belongs to '${dbAgent?.workspace?.slug ?? "(none)"}'. Connect with an agent from that workspace, or use the unscoped /mcp endpoint.`,
        },
      }, 403);
    }
  }

  const session = prepareMcpSession(c, agent);
  if (!session.ok) {
    return c.json({
      jsonrpc: "2.0", id: null,
      error: { code: -32002, message: session.message },
    }, session.status as any);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const { method, params, id } = body ?? {};

  // --- MCP handshake ---
  // Remote MCP clients (Claude Desktop via mcp-remote, Claude Code, Codex) call
  // initialize before listing/calling tools. Keep this lightweight; auth still
  // gates tenant-specific tools and calls below.
  if (method === "initialize") {
    return c.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: String(params?.protocolVersion ?? MCP_PROTOCOL_VERSION),
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "grantry",
          version: "0.1.0",
        },
      },
    });
  }

  if (method === "notifications/initialized") {
    return c.body(null, 204);
  }

  if (method === "ping") {
    return c.json({ jsonrpc: "2.0", id, result: {} });
  }

  // --- tools/list: scoped to the calling agent's permitted tools ---
  // Unauthenticated requests only see `ping`; an authenticated agent only sees
  // tools backed by enabled connections it can actually call.
  if (method === "tools/list") {
    const connections = agent
      ? (await connectionsForAgent(agent.id)).filter((conn) => !configuredScope || conn.scope === configuredScope)
      : null;
    // Tools the agent can reach only by delegation (a capable peer holds them).
    // Surfaced so the mint-then-redeem flow has a callable entrypoint.
    let delegatable = new Map<string, Set<string>>();
    if (agent) {
      delegatable = await delegatableToolsForAgent(agent.id);
      if (configuredScope) {
        for (const [tool, scopes] of delegatable) {
          const filtered = new Set(Array.from(scopes).filter((s) => s === configuredScope));
          if (filtered.size) delegatable.set(tool, filtered);
          else delegatable.delete(tool);
        }
      }
    }
    return c.json({ jsonrpc: "2.0", id, result: { tools: buildToolList(connections, delegatable) } });
  }

  // --- connections/list: requires auth; returns the exact (provider, scope)
  // pairs the agent can use, so it never has to guess `scope` for tools/call. ---
  if (method === "connections/list") {
    if (!agent) {
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32001, message: "authentication required: pass 'Authorization: Bearer gn_agt_...'" },
      }, 401);
    }
    const connections = (await connectionsForAgent(agent.id)).filter((conn) => !configuredScope || conn.scope === configuredScope);
    return c.json({ jsonrpc: "2.0", id, result: { connections } });
  }

  // --- tools/call: requires auth ---
  if (method === "tools/call") {
    const requestedToolName = String(params?.name ?? "");
    const toolName = canonicalToolName(requestedToolName);
    const args = params?.arguments ?? {};

    // grantry/delegate executes a real provider call, so it runs through the
    // authenticated path below (rate limit + audit), not the metadata helper.
    if (SYSTEM_TOOLS.includes(toolName as any) && toolName !== "grantry/delegate") {
      if (AUTHED_SYSTEM_TOOLS.has(toolName) && !agent) {
        return c.json({
          jsonrpc: "2.0", id,
          error: { code: -32001, message: "authentication required: pass 'Authorization: Bearer gn_agt_...'" },
        }, 401);
      }
      // Resolve identity for any authenticated caller (not just AUTHED tools):
      // the public metadata tools (e.g. get_providers) optionally enrich their
      // output with the caller's scopes when a token is present.
      let systemCtx: SystemToolContext | undefined;
      if (agent) {
        const self = await prisma.agent.findUnique({ where: { id: agent.id }, select: { ownerId: true, workspaceId: true } });
        if (self) systemCtx = { agentId: agent.id, ownerId: self.ownerId, workspaceId: self.workspaceId };
      }
      try {
        const result = await callSystemTool(toolName, args, systemCtx);
        return c.json({ jsonrpc: "2.0", id, result });
      } catch (e: any) {
        return c.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Error: ${String(e?.message ?? e)}` }], isError: true },
        });
      }
    }

    if (!agent) {
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32001, message: "authentication required: pass 'Authorization: Bearer gn_agt_...'" },
      }, 401);
    }

    const requestedScope = args.scope === undefined || args.scope === null ? "" : String(args.scope);
    const scope = requestedScope || configuredScope;
    const authType = args.auth_type !== undefined ? String(args.auth_type) : (args.authType !== undefined ? String(args.authType) : "");
    const connectionId = args.connection_id !== undefined ? String(args.connection_id) : (args.connectionId !== undefined ? String(args.connectionId) : "");
    const grantToken = args.grant_token !== undefined ? String(args.grant_token) : (args.grantToken !== undefined ? String(args.grantToken) : "");

    if (rateLimitExceeded(agent.id)) {
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32029, message: `rate limited: max ${RATE_LIMIT_PER_MINUTE} tools/call per minute per agent` },
      }, 429);
    }

    await prisma.agent.update({
      where: { id: agent.id },
      data: { lastUsedAt: new Date() },
    });

    // grantry/delegate: mint a single-use, time-boxed permission slip so a
    // capable peer's (tool, scope) becomes runnable by the caller — WITHOUT
    // grantry executing anything. grantry stays the gate: it returns a one-time
    // grant_token, and the caller (or a sub-agent using its token) then makes a
    // normal tools/call presenting that token. Execution is driven by the
    // agent; grantry only manages permission (docs/agent-orchestration.md).
    if (toolName === "grantry/delegate") {
      const targetAgentId = String((args as any).agent_id ?? (args as any).agentId ?? "");
      const delegTool = normalizeToolName((args as any).tool);
      const delegScope = (args as any).scope == null ? "" : String((args as any).scope);

      const fail = async (code: number, message: string, status = 400) => {
        await prisma.auditLog.create({ data: {
          agentId: agent.id,
          provider: delegTool.includes("/") ? delegTool.split("/", 1)[0] : "system",
          tool: delegTool || "grantry/delegate",
          scope: delegScope,
          status: "denied",
          errorMessage: message,
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        } }).catch(() => {});
        return c.json({ jsonrpc: "2.0", id, error: { code, message } }, status as any);
      };

      if (!targetAgentId) return fail(-32602, "delegate requires 'agent_id'");
      if (!delegTool.includes("/")) return fail(-32602, "delegate requires a 'tool' like 'railway/graphql'");
      if (!delegScope) return fail(-32602, "delegate requires 'scope'");

      const [self, target] = await Promise.all([
        prisma.agent.findUnique({ where: { id: agent.id }, select: { ownerId: true } }),
        prisma.agent.findUnique({ where: { id: targetAgentId }, select: { id: true, name: true, enabled: true, ownerId: true, expiresAt: true } }),
      ]);
      if (!self) return fail(-32011, "calling agent vanished", 500);
      if (target?.id === agent.id) return fail(-32602, "cannot delegate to yourself");
      if (!target || !target.enabled) return fail(-32010, "target agent not found or disabled", 403);
      if (target.expiresAt && target.expiresAt < new Date()) return fail(-32010, "target agent token expired", 403);
      // Owner boundary: delegation never crosses owners (cross-owner routing is
      // a larger policy decision — see the design doc).
      if (target.ownerId !== self.ownerId) return fail(-32010, "delegation is limited to agents that share your owner", 403);

      // The target must genuinely be capable — same predicate as a direct call.
      const decision = await checkPolicy({ agentId: target.id, tool: delegTool, scope: delegScope });
      if (!decision.allowed) return fail(-32010, `target agent cannot run this: ${decision.reason}`, 403);

      // Mint the one-time grant. Only the token hash is stored; the plaintext is
      // returned once and never persisted.
      const grantToken = `gn_grant_${randomBytes(24).toString("base64url")}`;
      const tokenHash = createHash("sha256").update(grantToken).digest("hex");
      const expiresAt = new Date(Date.now() + DELEGATION_TTL_MS);
      const grant = await prisma.delegationGrant.create({ data: {
        requesterAgentId: agent.id,
        targetAgentId: target.id,
        tool: delegTool,
        scope: delegScope,
        tokenHash,
        expiresAt,
      } });
      await prisma.auditLog.create({ data: {
        agentId: agent.id,
        delegatedById: agent.id,
        delegationId: grant.id,
        provider: decision.provider,
        tool: delegTool,
        scope: delegScope,
        status: "ok",
        responseSummary: `granted: run ${delegTool} on ${delegScope || "<empty>"} via ${target.name} (single-use)`,
        requestArgs: maskAuditArgs(args),
        durationMs: Date.now() - started,
        ipAddress: c.req.header("x-forwarded-for") ?? null,
      } });

      const payload = {
        delegationId: grant.id,
        grant_token: grantToken,
        target: target.name,
        tool: delegTool,
        scope: delegScope,
        expiresAt: expiresAt.toISOString(),
        usage: `call ${publicToolName(delegTool)} normally with arguments { scope: "${delegScope}", grant_token: "<this token>", ... }. Single-use; expires at ${expiresAt.toISOString()}.`,
      };
      return c.json({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: false,
      } });
    }

    // 1) Special case: ping
    if (toolName === "ping") {
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          provider: "system",
          tool: "ping",
          status: "ok",
          durationMs: Date.now() - started,
        },
      });
      return c.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `pong from ${agent.name}` }] } });
    }

    if (configuredScope && requestedScope && requestedScope !== configuredScope) {
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          provider: toolName.includes("/") ? toolName.split("/", 1)[0] : "unknown",
          tool: String(toolName ?? ""),
          scope: requestedScope,
          status: "denied",
          errorMessage: `MCP server is locked to scope=${configuredScope}`,
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        },
      });
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32010, message: `policy denied: ${requestedToolName} (MCP server is locked to scope=${configuredScope})` },
      }, 403);
    }

    // 1.5) Redeem a delegation grant, if presented. The caller holds a one-time
    // slip authorizing exactly this (tool, scope) via a capable peer. grantry
    // gates + proxies as always, but routes through the TARGET's connection.
    // The agent drove this call; grantry only honored the permission slip.
    if (grantToken) {
      const tokenHash = createHash("sha256").update(grantToken).digest("hex");
      const grant = await prisma.delegationGrant.findUnique({ where: { tokenHash } });
      const now = new Date();
      const invalid =
        !grant ? "unknown grant token"
        : grant.status !== "issued" ? "grant already used"
        : grant.expiresAt < now ? "grant expired"
        : grant.requesterAgentId !== agent.id ? "grant was issued to a different agent"
        : grant.tool !== toolName ? `grant authorizes ${grant.tool}, not ${toolName}`
        : grant.scope !== scope ? `grant authorizes scope ${grant.scope || "<empty>"}, not ${scope || "<empty>"}`
        : "";
      if (invalid) {
        await prisma.auditLog.create({ data: {
          agentId: agent.id,
          provider: toolName.includes("/") ? toolName.split("/", 1)[0] : "system",
          tool: toolName, scope, status: "denied",
          errorMessage: `delegation grant rejected: ${invalid}`,
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        } });
        return c.json({ jsonrpc: "2.0", id, error: { code: -32010, message: `delegation grant rejected: ${invalid}` } }, 403);
      }

      // Re-verify the target is still capable (connection grants may have moved
      // since the grant was minted).
      const decision = await checkPolicy({ agentId: grant!.targetAgentId, tool: toolName, scope });
      if (!decision.allowed) {
        await prisma.delegationGrant.update({ where: { id: grant!.id }, data: { status: "consumed", consumedAt: now } }).catch(() => {});
        await prisma.auditLog.create({ data: {
          agentId: agent.id, delegatedById: agent.id, delegationId: grant!.id,
          provider: decision.provider, tool: toolName, scope, status: "denied",
          errorMessage: `target no longer capable: ${decision.reason}`,
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        } });
        return c.json({ jsonrpc: "2.0", id, error: { code: -32010, message: `target no longer capable: ${decision.reason}` } }, 403);
      }
      const conn = await prisma.connection.findUnique({ where: { id: decision.connectionId! } });
      if (!conn) return c.json({ jsonrpc: "2.0", id, error: { code: -32011, message: "connection vanished" } }, 500);

      const innerArgs: Record<string, unknown> = { ...args };
      delete innerArgs.grant_token;
      delete innerArgs.grantToken;
      try {
        const credential = await credentialForConnection(conn);
        const scopeDenied = await assertProviderScopesBeforeDispatch({ provider: decision.provider, toolName, token: credential, conn });
        if (scopeDenied) {
          await prisma.auditLog.create({ data: {
            agentId: grant!.targetAgentId, delegatedById: agent.id, delegationId: grant!.id,
            connectionId: conn.id,
            provider: decision.provider, tool: toolName, scope, status: "denied",
            errorMessage: scopeDenied.message,
            requestArgs: maskAuditArgs(innerArgs),
            durationMs: Date.now() - started,
            ipAddress: c.req.header("x-forwarded-for") ?? null,
          } });
          return c.json({ jsonrpc: "2.0", id, error: { code: -32012, message: scopeDenied.message, data: scopeDenied } }, 403);
        }

        // Burn the single use up front: a failed provider call still consumes the grant.
        await prisma.delegationGrant.update({ where: { id: grant!.id }, data: { status: "consumed", consumedAt: now } });
        const result = await dispatchProviderTool(decision.provider, toolName, innerArgs, credential, conn);
        await prisma.auditLog.create({ data: {
          agentId: grant!.targetAgentId, delegatedById: agent.id, delegationId: grant!.id,
          connectionId: conn.id,
          provider: decision.provider, tool: toolName, scope, status: "ok",
          responseSummary: JSON.stringify({ delegatedBy: agent.name, connectionId: conn.id, result }).slice(0, 500),
          requestArgs: maskAuditArgs(innerArgs),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        } });
        return c.json({ jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: JSON.stringify(result.structuredContent ?? result).slice(0, 8000) }],
          structuredContent: result.structuredContent,
          isError: false,
        } });
      } catch (e: any) {
        const errMsg = String(e?.message ?? e);
        await prisma.auditLog.create({ data: {
          agentId: grant!.targetAgentId, delegatedById: agent.id, delegationId: grant!.id,
          connectionId: conn.id,
          provider: decision.provider, tool: toolName, scope, status: "error",
          errorMessage: errMsg.slice(0, 2000),
          requestArgs: maskAuditArgs(innerArgs),
          durationMs: Date.now() - started,
        } });
        return c.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${errMsg}` }], isError: true } });
      }
    }

    // 2) Policy check
    const decision = await checkPolicy({ agentId: agent.id, tool: toolName, scope, authType, connectionId });
    if (!decision.allowed) {
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "denied",
          errorMessage: decision.reason,
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        },
      });
      // Signpost: don't dead-end. If another agent in the caller's workspace can
      // run this (tool, scope), point at it (docs/agent-orchestration.md). Only
      // included when a capable peer actually exists, so we never leak "nobody
      // can do this". Identities/capability facts only — never tokens.
      const errorObj: any = { code: -32010, message: `policy denied: ${toolName} (${decision.reason})` };
      try {
        const self = await prisma.agent.findUnique({ where: { id: agent.id }, select: { ownerId: true, workspaceId: true } });
        if (self) {
          const capable = await findCapableAgents({
            tool: toolName, scope,
            workspaceId: self.workspaceId, ownerId: self.ownerId,
            excludeAgentId: agent.id,
          });
          if (capable.length) {
            errorObj.data = {
              capableAgents: capable.slice(0, 5).map((m) => ({
                name: m.name, grants: m.grants, scopes: m.scopes,
                connection: m.connection.enabled ? "live" : "disabled",
              })),
              hint: `another agent in this workspace can run ${toolName}; ask an admin to route this, or call grantry_find_agent`,
            };
          }
        }
      } catch { /* signpost is best-effort; never block the denial on it */ }
      return c.json({ jsonrpc: "2.0", id, error: errorObj }, 403);
    }

    // 3) Look up connection, decrypt credential
    const conn = await prisma.connection.findUnique({ where: { id: decision.connectionId! } });
    if (!conn) {
      return c.json({ jsonrpc: "2.0", id, error: { code: -32011, message: "connection vanished" } }, 500);
    }
    const token = await credentialForConnection(conn);
    const scopeDenied = await assertProviderScopesBeforeDispatch({ provider: decision.provider, toolName, token, conn });
    if (scopeDenied) {
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          connectionId: conn.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "denied",
          errorMessage: scopeDenied.message,
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        },
      });
      return c.json({ jsonrpc: "2.0", id, error: { code: -32012, message: scopeDenied.message, data: scopeDenied } }, 403);
    }

    // 4) Dispatch to provider-specific tool
    try {
      const result = await dispatchProviderTool(decision.provider, toolName, args, token, conn);

      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          connectionId: conn.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "ok",
          responseSummary: JSON.stringify({ authType: decision.authType, connectionId: conn.id, result }).slice(0, 500),
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
          ipAddress: c.req.header("x-forwarded-for") ?? null,
        },
      });

      return c.json({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result.structuredContent ?? result).slice(0, 8000) }],
          structuredContent: result.structuredContent,
          isError: false,
        },
      });
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
          connectionId: conn.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "error",
          errorMessage: errMsg.slice(0, 2000),
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
        },
      });
      return c.json({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
        },
      });
    }
  }

  return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
};

mcpApp.post("/", handleMcpPost);
// Workspace-locked and scope-locked connector URLs. Distinct URLs let
// claude.ai / Claude Desktop register parallel connectors (same-URL
// duplicates are rejected by those clients) — see docs/workspace-design.md.
mcpApp.post("/w/:ws", handleMcpPost);
mcpApp.post("/s/:scope", handleMcpPost);
mcpApp.post("/w/:ws/s/:scope", handleMcpPost);
