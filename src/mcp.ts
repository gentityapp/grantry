// MCP JSON-RPC gateway with auth + policy + dispatch
// Phase 2: implements real tool dispatch for notion/* and github/*
// Phase 3: scope-based policy enforcement
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { prisma } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { checkPolicy, connectionsForAgent } from "./policy.js";
import { PROVIDERS } from "./connectors/registry.js";
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
import { callFreeeTool } from "./connectors/freee.js";
import { callMoneyForwardTool } from "./connectors/moneyforward.js";
import { callRedditTool } from "./connectors/reddit.js";
import { callXTool } from "./connectors/x.js";
import { credentialMetadataForStorage } from "./connectors/credential_meta.js";

export const mcpApp = new Hono();

const TOKEN_REFRESH_TIMEOUT_MS = 8_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MCP_SESSION_TTL_MS = 60 * 60 * 1000;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const SKILL_URL = new URL("../docs/skill.md", import.meta.url);

const SYSTEM_TOOLS = [
  "grantry/get_skill",
  "grantry/get_providers",
] as const;

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
  if (toolName === "moneyforward/get_office") {
    return {};
  }
  if (toolName === "moneyforward/list_partners") {
    return {
      page: { type: "number", description: "Page number." },
      per_page: { type: "number", minimum: 1, maximum: 100, description: "Results per page, max 100." },
      q: { type: "string", description: "Search keyword." },
    };
  }
  if (toolName === "moneyforward/get_partner") {
    return {
      partner_id: { type: "string", description: "Money Forward partner (取引先) id. Required." },
    };
  }
  if (toolName === "moneyforward/create_partner") {
    return {
      name: { type: "string", description: "Partner (取引先) name. Required." },
      partner: { type: "object", description: "Raw Money Forward partner body; overrides individual fields." },
    };
  }
  if (toolName === "moneyforward/list_billings") {
    return {
      page: { type: "number", description: "Page number." },
      per_page: { type: "number", minimum: 1, maximum: 100, description: "Results per page, max 100." },
      range_key: { type: "string", description: "Date field to filter on, e.g. billing_date." },
      from: { type: "string", description: "Range lower bound, YYYY-MM-DD." },
      to: { type: "string", description: "Range upper bound, YYYY-MM-DD." },
      q: { type: "string", description: "Search keyword." },
    };
  }
  if (toolName === "moneyforward/get_billing") {
    return {
      billing_id: { type: "string", description: "Money Forward billing (請求書) id. Required." },
    };
  }
  if (toolName === "moneyforward/list_quotes") {
    return {
      page: { type: "number", description: "Page number." },
      per_page: { type: "number", minimum: 1, maximum: 100, description: "Results per page, max 100." },
      range_key: { type: "string", description: "Date field to filter on, e.g. quote_date." },
      from: { type: "string", description: "Range lower bound, YYYY-MM-DD." },
      to: { type: "string", description: "Range upper bound, YYYY-MM-DD." },
      q: { type: "string", description: "Search keyword." },
    };
  }
  if (toolName === "moneyforward/list_items") {
    return {
      page: { type: "number", description: "Page number." },
      per_page: { type: "number", minimum: 1, maximum: 100, description: "Results per page, max 100." },
      q: { type: "string", description: "Search keyword." },
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
  return {};
}

function requiredToolSpecificArgs(toolName: string): string[] {
  if (SYSTEM_TOOLS.includes(toolName as any)) return [];
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
  if (toolName === "freee/list_deals") return ["company_id"];
  if (toolName === "freee/get_deal") return ["company_id", "deal_id"];
  if (toolName === "freee/create_deal") return ["company_id", "issue_date", "type"];
  if (toolName === "freee/list_account_items") return ["company_id"];
  if (toolName === "freee/list_partners") return ["company_id"];
  if (toolName === "freee/create_partner") return ["company_id", "name"];
  if (toolName === "freee/trial_pl") return ["company_id"];
  if (toolName === "freee/trial_bs") return ["company_id"];
  if (toolName === "moneyforward/get_partner") return ["partner_id"];
  if (toolName === "moneyforward/create_partner") return ["name"];
  if (toolName === "moneyforward/get_billing") return ["billing_id"];
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
      oauth_scopes: p.oauthScopes ?? [],
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

async function callSystemTool(toolName: string, args: Record<string, unknown>) {
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
    return {
      content: [{ type: "text", text: JSON.stringify(providers, null, 2) }],
      structuredContent: providers,
      isError: false,
    };
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
 * - Otherwise only tools that have an enabled, policy-usable connection are listed.
 */
function buildToolList(connections: Awaited<ReturnType<typeof connectionsForAgent>> | null) {
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
      const scopes = Array.from(scopesByTool.get(toolName) ?? []).sort();
      if (!scopes.length) continue;
      const authTypes = Array.from(authTypesByTool.get(toolName) ?? []).sort();
      const connectionIds = Array.from(connectionIdsByTool.get(toolName) ?? []).sort();
      tools.push({
        name: publicToolName(toolName),
        description: `${p.label}: ${toolName.split("/")[1]?.replace(/_/g, " ")}`,
        inputSchema: {
          type: "object",
          properties: {
            scope: { type: "string", enum: scopes, description: "Tenant scope. Use one of the scopes exposed for this agent token." },
            auth_type: { type: "string", enum: authTypes, description: "Optional auth type disambiguator." },
            connection_id: { type: "string", enum: connectionIds, description: "Optional connection id disambiguator." },
            ...toolSpecificInputProperties(toolName),
          },
          required: ["scope", ...requiredToolSpecificArgs(toolName)],
        },
      });
    }
  }
  return tools;
}

/** Resolve agent from Authorization: Bearer gn_agt_* */
async function resolveAgent(authHeader: string | null): Promise<{ id: string; name: string; enabled: boolean } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  if (!token.startsWith("gn_agt_")) return null;

  // Look up by token hash (hashedToken is unique but not the @id, so use findFirst)
  const crypto = await import("node:crypto");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const agent = await prisma.agent.findFirst({ where: { hashedToken: tokenHash } });
  if (!agent || !agent.enabled) return null;
  if (agent.expiresAt && agent.expiresAt < new Date()) return null;
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

async function refreshOAuthToken(provider: string, refreshToken: string) {
  const providerDef = PROVIDERS[provider];
  if (!providerDef?.oauthTokenUrl) throw new Error(`OAuth refresh is not configured for provider: ${provider}`);

  const envPrefix = provider.toUpperCase();
  const legacyAliases: Record<string, string[]> = {
    github: ["GH_CLIENT_ID", "GRANTRY_GITHUB_CLIENT_ID"],
    google_gsc: ["GOOGLE_CLIENT_ID"],
    google_analytics: ["GOOGLE_CLIENT_ID"],
    google_ads: ["GOOGLE_CLIENT_ID"],
    google_drive: ["GOOGLE_CLIENT_ID"],
    gmail: ["GOOGLE_CLIENT_ID"],
    youtube: ["GOOGLE_CLIENT_ID"],
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
    yahoo_ads: ["YAHOO_CLIENT_SECRET"],
  };
  const clientId = process.env[`${envPrefix}_CLIENT_ID`]
    || (legacyAliases[provider] || []).map((k) => process.env[k]).find(Boolean);
  const clientSecret = process.env[`${envPrefix}_CLIENT_SECRET`]
    || (legacySecretAliases[provider] || []).map((k) => process.env[k]).find(Boolean);
  if (!clientId || !clientSecret) {
    throw new Error(`${provider} OAuth refresh credentials missing: set ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET`);
  }

  // Reddit and X authenticate the confidential client with HTTP Basic auth at
  // the token endpoint rather than client credentials in the body.
  const usesBasicAuth = provider === "reddit" || provider === "x";
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
  authType: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}) {
  const currentToken = decrypt(conn.encryptedCredential);
  if (!conn.refreshToken || !conn.accessTokenExpiresAt) return currentToken;
  if (conn.accessTokenExpiresAt.getTime() > Date.now() + TOKEN_REFRESH_SKEW_MS) return currentToken;

  console.log("[oauth] refreshing access token", {
    provider: conn.provider,
    connectionId: conn.id,
    expiresAt: conn.accessTokenExpiresAt.toISOString(),
  });
  const refreshed = await refreshOAuthToken(conn.provider, decrypt(conn.refreshToken));
  await prisma.connection.update({
    where: { id: conn.id },
    data: {
      encryptedCredential: encrypt(refreshed.access_token),
      accessTokenExpiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
      ...(await credentialMetadataForStorage(conn.provider, conn.authType, refreshed.access_token)),
      ...(refreshed.refresh_token ? { refreshToken: encrypt(refreshed.refresh_token) } : {}),
    },
  });
  return refreshed.access_token;
}

mcpApp.post("/", async (c) => {
  const started = Date.now();
  const auth = c.req.header("authorization") ?? null;
  const agent = await resolveAgent(auth);
  const configuredScope = configuredMcpScope(c);
  c.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
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
    return c.json({ jsonrpc: "2.0", id, result: { tools: buildToolList(connections) } });
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

    if (SYSTEM_TOOLS.includes(toolName as any)) {
      try {
        const result = await callSystemTool(toolName, args);
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
      return c.json({
        jsonrpc: "2.0", id,
        error: { code: -32010, message: `policy denied: ${toolName} (${decision.reason})` },
      }, 403);
    }

    // 3) Look up connection, decrypt credential
    const conn = await prisma.connection.findUnique({ where: { id: decision.connectionId! } });
    if (!conn) {
      return c.json({ jsonrpc: "2.0", id, error: { code: -32011, message: "connection vanished" } }, 500);
    }
    const token = await credentialForConnection(conn);

    // 4) Dispatch to provider-specific tool
    try {
      let result: any;
      if (decision.provider === "notion") {
        result = await callNotionTool(toolName, args, token);
      } else if (decision.provider === "github") {
        result = await callGitHubTool(toolName, args, token);
      } else if (decision.provider === "cloudflare") {
        result = await callCloudflareTool(toolName, args, token);
      } else if (decision.provider === "clarity") {
        result = await callClarityTool(toolName, args, token);
      } else if (decision.provider === "google_drive") {
        result = await callGoogleDriveTool(toolName, args, token);
      } else if (decision.provider === "google_gsc") {
        result = await callGoogleGscTool(toolName, args, token);
      } else if (decision.provider === "google_analytics") {
        result = await callGoogleAnalyticsTool(toolName, args, token);
      } else if (decision.provider === "google_ads") {
        result = await callGoogleAdsTool(toolName, args, token, conn.encryptedServerCredential ? decrypt(conn.encryptedServerCredential) : null);
      } else if (decision.provider === "yahoo_ads") {
        result = await callYahooAdsTool(toolName, args, token);
      } else if (decision.provider === "meta_ads") {
        result = await callMetaAdsTool(toolName, args, token);
      } else if (decision.provider === "hubspot") {
        result = await callHubSpotTool(toolName, args, token);
      } else if (decision.provider === "gmail") {
        result = await callGmailTool(toolName, args, token);
      } else if (decision.provider === "youtube") {
        result = await callYouTubeTool(toolName, args, token);
      } else if (decision.provider === "attio") {
        result = await callAttioTool(toolName, args, token);
      } else if (decision.provider === "clay") {
        result = await callClayTool(toolName, args, token);
      } else if (decision.provider === "heyreach") {
        result = await callHeyReachTool(toolName, args, token);
      } else if (decision.provider === "chatwork") {
        result = await callChatworkTool(toolName, args, token);
      } else if (decision.provider === "railway") {
        result = await callRailwayTool(toolName, args, token);
      } else if (decision.provider === "google_maps") {
        result = await callGoogleMapsTool(toolName, args, token);
      } else if (decision.provider === "resend") {
        result = await callResendTool(toolName, args, token);
      } else if (decision.provider === "freee") {
        result = await callFreeeTool(toolName, args, token);
      } else if (decision.provider === "moneyforward") {
        result = await callMoneyForwardTool(toolName, args, token);
      } else if (decision.provider === "reddit") {
        result = await callRedditTool(toolName, args, token);
      } else if (decision.provider === "x") {
        result = await callXTool(toolName, args, token);
      } else {
        throw new Error(`no dispatcher for provider: ${decision.provider}`);
      }

      await prisma.auditLog.create({
        data: {
          agentId: agent.id,
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
});
