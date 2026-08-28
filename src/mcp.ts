// MCP JSON-RPC gateway with auth + policy + dispatch
// Phase 2: implements real tool dispatch for notion/* and github/*
// Phase 3: scope-based policy enforcement
import { Hono } from "hono";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { prisma } from "./db.js";
import { decrypt, encrypt } from "./crypto.js";
import { recordRuntimeCallHealth } from "./connection_health.js";
import { createUploadTicket } from "./files.js";
import { checkPolicy, connectionsForAgent, delegatableToolsForAgent, findCapableAgents, guessToolsFromTask, normalizeToolName } from "./policy.js";
import { PROVIDERS, getProviderForWorkspace, listProvidersForWorkspace } from "./connectors/registry.js";
import { callNotionTool } from "./connectors/notion.js";
import { callGitHubTool } from "./connectors/github.js";
import { callCloudflareTool } from "./connectors/cloudflare.js";
import { callGodaddyTool } from "./connectors/godaddy.js";
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
import { callApolloTool } from "./connectors/apollo.js";
import { callHeyReachTool } from "./connectors/heyreach.js";
import { callSmartleadTool } from "./connectors/smartlead.js";
import { callChatworkTool } from "./connectors/chatwork.js";
import { callChannelTalkTool, callChannelTalkDocumentsTool } from "./connectors/channel_talk.js";
import { callRailwayTool } from "./connectors/railway.js";
import { callResendTool } from "./connectors/resend.js";
import { callGranolaTool } from "./connectors/granola.js";
import { callTldvTool } from "./connectors/tldv.js";
import { callZapmailTool } from "./connectors/zapmail.js";
import { callCloudSignTool } from "./connectors/cloudsign.js";
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
import { callOpenAITool } from "./connectors/openai.js";
import { callOpenAIAdsTool } from "./connectors/openai_ads.js";
import { callHiggsfieldTool } from "./connectors/higgsfield.js";
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
import { callGoogleSlidesTool } from "./connectors/google_slides.js";
import { callGoogleFormsTool } from "./connectors/google_forms.js";
import { callTwentyTool } from "./connectors/twenty.js";
import { callNocodbTool } from "./connectors/nocodb.js";
import { callSeminarPortalTool } from "./connectors/seminar_portal.js";
import { callIntentEngineTool } from "./connectors/intent_engine.js";
import { callLanggraphTool } from "./connectors/langgraph.js";
import { callLangsmithTool } from "./connectors/langsmith.js";
import { callMonidTool } from "./connectors/monid.js";
import { callYouCanBookMeTool } from "./connectors/youcanbookme.js";
import { callCalcomTool } from "./connectors/calcom.js";
import { callAcuityTool } from "./connectors/acuity.js";
import { callTimerexTool } from "./connectors/timerex.js";
import { callJicooTool } from "./connectors/jicoo.js";
import { callFirecrawlTool } from "./connectors/firecrawl.js";
import { callDataForSeoTool } from "./connectors/dataforseo.js";
import { callCalendlyTool } from "./connectors/calendly.js";
import { callGoogleTagManagerTool } from "./connectors/google_tag_manager.js";
import { callGoogleCloudTool } from "./connectors/google_cloud.js";
import { callBigQueryTool } from "./connectors/bigquery.js";
import { callGoogleAdminTool } from "./connectors/google_admin.js";
import { credentialMetadataForStorage } from "./connectors/credential_meta.js";
import { mintDwdAccessToken, type ServiceAccountCredential } from "./google_dwd.js";
import { callGenericCheckConnection, callGenericListCapabilities, callGenericProviderRequest } from "./connectors/generic_request.js";
import { connectableAgentsFor, userMayUseAgent } from "./workspaces.js";
import { connectionCredentialData, providerCredentialData } from "./provider_credentials.js";
import { adminToolDescriptor, isAdminTool } from "./admin_tools.js";
import { agentIdIsToolTarget, stripActingAgentSelector } from "./acting_agent_args.js";
import { callGrantryAdminTool } from "./connectors/grantry_admin.js";

export const mcpApp = new Hono();

const TOKEN_REFRESH_TIMEOUT_MS = 8_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const MCP_SESSION_TTL_MS = 60 * 60 * 1000;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const SKILL_URL = new URL("../docs/skill.md", import.meta.url);

const SYSTEM_TOOLS = [
  "grantry/get_skill",
  "grantry/get_runbook",
  "grantry/get_runbook_file",
  "grantry/get_providers",
  "grantry/list_user_agents",
  "grantry/list_scopes",
  "grantry/find_agent",
  "grantry/route",
  "grantry/delegate",
  "grantry/create_upload_url",
] as const;

// System tools that need the calling agent's identity (workspace boundary) and
// therefore require authentication, unlike the public metadata tools.
const AUTHED_SYSTEM_TOOLS = new Set<string>(["grantry/get_runbook", "grantry/get_runbook_file", "grantry/list_user_agents", "grantry/list_scopes", "grantry/find_agent", "grantry/route", "grantry/delegate", "grantry/create_upload_url"]);

// Capability-scoped delegation TTL: short by design (single-use anyway).
const DELEGATION_TTL_MS = 5 * 60 * 1000;

type McpSession = {
  principalKey: string;
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

function isUserMcpMode(c: any): boolean {
  // c.req.path is the FULL request path (/mcp/u/w/<ws>), not the path relative
  // to where mcpApp is mounted — strip the mount prefix before matching.
  const path = String(c.req.path ?? "").toLowerCase().replace(/^\/mcp/, "");
  return path === "/u" || path.startsWith("/u/");
}

function publicToolName(canonicalName: string): string {
  return canonicalName === "ping" ? canonicalName : canonicalName.replace("/", "_");
}

function metaAdsRuntimeToolName(toolName: string): string {
  return toolName.startsWith("meta_ads_platform/")
    ? toolName.replace("meta_ads_platform/", "meta_ads/")
    : toolName;
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
  const customMatch = raw.match(/^([a-z0-9_-]+)_(request|check_connection|list_capabilities)$/);
  if (customMatch) return `${customMatch[1]}/${customMatch[2]}`;
  return raw;
}

function toolSpecificInputProperties(toolName: string): Record<string, any> {
  const metaToolName = metaAdsRuntimeToolName(toolName);
  if (isAdminTool(toolName)) return adminToolDescriptor(toolName).properties as Record<string, any>;
  if (toolName === "grantry/get_skill") {
    return {
      format: { type: "string", enum: ["markdown"], description: "Output format. Defaults to markdown." },
    };
  }
  if (toolName === "grantry/get_runbook") {
    return {
      format: { type: "string", enum: ["markdown"], description: "Output format. Defaults to markdown." },
    };
  }
  if (toolName === "grantry/get_runbook_file") {
    return {
      path: { type: "string", description: "A file path from grantry_get_runbook's file list, e.g. 'event-rfp/scripts/build.py'." },
    };
  }
  if (toolName === "grantry/get_providers") {
    return {
      include_tools: { type: "boolean", description: "When true, include each provider's tool names. Defaults to true." },
    };
  }
  if (toolName === "grantry/list_user_agents") {
    return {};
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
  if (toolName === "grantry/create_upload_url") {
    return {
      acting_agent_id: { type: "string", description: "Only on /mcp/u: agent id this authenticated user is acting through. Omit when the user has exactly one usable agent." },
      ttl_seconds: { type: "number", description: "How long the upload URL stays valid. Default 1800, max 3600." },
      max_uses: { type: "number", description: "How many uploads the URL accepts. Default 1, max 10." },
    };
  }
  if (toolName === "grantry/delegate") {
    return {
      acting_agent_id: { type: "string", description: "Only on /mcp/u: agent id this authenticated user is acting through. Omit when the user has exactly one usable agent." },
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
      base_branch: { type: "string", description: "When the target branch is new, base it on this branch (inherit its history + full tree). Defaults to the repo's default branch. Prevents orphan branches." },
      commit_message: { type: "string", description: "Commit message. Defaults to 'chore: update via grantry'." },
      files: {
        type: "object",
        additionalProperties: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                content: { type: "string", description: "UTF-8 text content." },
                base64: { type: "string", description: "Binary content, base64-encoded (a data: URI prefix is stripped)." },
                url: { type: "string", description: "Binary source URL; grantry fetches the bytes server-side and commits them as a blob." },
              },
            },
          ],
        },
        description: "Map of repository file path to content. Value is either a UTF-8 text string, e.g. { \"README.md\": \"# Title\" }, OR for binary files an object: { \"img/hero.webp\": { url: \"https://...\" } } (grantry fetches the bytes) or { base64: \"...\" }. All files land in a single commit. Use the url form for images — never paste base64.",
      },
    };
  }
  if (toolName === "github/create_pull_request") {
    return {
      owner: { type: "string", description: "Repository owner (user or org)." },
      repo: { type: "string", description: "Repository name." },
      title: { type: "string", description: "Pull request title." },
      head: { type: "string", description: "Branch with the changes (e.g. seo/2026-06-20-foo)." },
      base: { type: "string", description: "Branch to merge into. Defaults to the repo's default branch." },
      body: { type: "string", description: "PR description (Markdown)." },
      draft: { type: "boolean", description: "Create as a draft PR. Defaults to true." },
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
  if (toolName === "godaddy/list_domains") {
    return {
      statuses: { type: "string", description: "Optional comma-separated domain statuses to filter, e.g. ACTIVE,CANCELLED." },
      marker: { type: "string", description: "Pagination marker: the last domain name from the previous page." },
      limit: { type: "number", minimum: 1, maximum: 1000, description: "Maximum domains to return (default 100)." },
    };
  }
  if (toolName === "godaddy/get_domain") {
    return {
      domain: { type: "string", description: "Domain name, e.g. example.com." },
    };
  }
  if (toolName === "godaddy/check_availability") {
    return {
      domain: { type: "string", description: "Domain name to check, e.g. example.com." },
      check_type: { type: "string", enum: ["FAST", "FULL"], description: "FAST (cached) or FULL (authoritative). Defaults to GoDaddy's default." },
    };
  }
  if (toolName === "godaddy/list_dns_records") {
    return {
      domain: { type: "string", description: "Domain name, e.g. example.com." },
      type: { type: "string", description: "Optional DNS record type filter, e.g. A, CNAME, MX, TXT." },
      name: { type: "string", description: "Optional DNS record name filter, e.g. www. Requires type when set." },
      offset: { type: "number", minimum: 1, description: "Pagination offset (1-based)." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Maximum records to return (default 100)." },
    };
  }
  if (toolName === "godaddy/add_dns_records") {
    return {
      domain: { type: "string", description: "Domain name, e.g. example.com." },
      type: { type: "string", description: "DNS record type for a single record, e.g. A, CNAME, MX, TXT." },
      name: { type: "string", description: "DNS record name for a single record, e.g. www or @." },
      data: { type: "string", description: "DNS record value for a single record, e.g. an IP, hostname, or text." },
      ttl: { type: "number", description: "TTL in seconds (minimum 600)." },
      priority: { type: "number", description: "Priority for MX/SRV records." },
      records: {
        type: "array",
        items: { type: "object" },
        description: "Optional array of record objects ({type,name,data,ttl,...}) to add in one call. Overrides the single-record fields.",
      },
    };
  }
  if (toolName === "godaddy/replace_dns_records") {
    return {
      domain: { type: "string", description: "Domain name, e.g. example.com." },
      type: { type: "string", description: "DNS record type to replace, e.g. A, CNAME, MX, TXT." },
      name: { type: "string", description: "DNS record name to replace, e.g. www or @." },
      data: { type: "string", description: "New record value for the single replacement record." },
      ttl: { type: "number", description: "TTL in seconds (minimum 600)." },
      priority: { type: "number", description: "Priority for MX/SRV records." },
      records: {
        type: "array",
        items: { type: "object" },
        description: "Optional array of record objects ({data,ttl,...}) to set for this type+name. Overrides the single-record fields.",
      },
    };
  }
  if (toolName === "godaddy/delete_dns_record") {
    return {
      domain: { type: "string", description: "Domain name, e.g. example.com." },
      type: { type: "string", description: "DNS record type to delete, e.g. A, CNAME, MX, TXT." },
      name: { type: "string", description: "DNS record name to delete, e.g. www or @." },
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
  if (toolName === "google_analytics/list_data_streams") {
    return {
      property_id: { type: "string", description: "GA4 property id, either 123456 or properties/123456." },
      page_size: { type: "number", minimum: 1, maximum: 200, description: "Page size, max 200." },
      page_token: { type: "string", description: "Optional pagination token." },
    };
  }
  if (toolName === "google_analytics/create_property") {
    return {
      account_id: { type: "string", description: "Parent GA4 account id, either 123456 or accounts/123456. Required." },
      display_name: { type: "string", description: "Display name for the new property, e.g. one-webinar.ai. Required." },
      time_zone: { type: "string", description: "IANA time zone. Defaults to Asia/Tokyo." },
      currency_code: { type: "string", description: "ISO 4217 currency code. Defaults to JPY." },
      industry_category: { type: "string", description: "Optional GA4 industry category enum, e.g. TECHNOLOGY." },
    };
  }
  if (toolName === "google_analytics/create_data_stream") {
    return {
      property_id: { type: "string", description: "GA4 property id, either 123456 or properties/123456. Required." },
      default_uri: { type: "string", description: "Website URL for the WEB data stream, e.g. https://one-webinar.ai. Required." },
      display_name: { type: "string", description: "Stream display name. Defaults to the default_uri." },
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
  if (metaToolName === "meta_ads/list_ad_accounts") {
    return {
      fields: { type: "string", description: "Comma-separated ad account fields. Defaults to id,account_id,name,account_status,currency,timezone_name." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Accounts to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (metaToolName === "meta_ads/get_ad_account") {
    return {
      account_id: { type: "string", description: "Meta ad account id, with or without the act_ prefix." },
      fields: { type: "string", description: "Comma-separated fields to include." },
    };
  }
  if (metaToolName === "meta_ads/list_campaigns") {
    return {
      account_id: { type: "string", description: "Meta ad account id, with or without the act_ prefix." },
      fields: { type: "string", description: "Comma-separated campaign fields." },
      effective_status: { type: "string", description: "Optional JSON array string to filter, e.g. [\"ACTIVE\",\"PAUSED\"]." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Campaigns to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (metaToolName === "meta_ads/get_campaign") {
    return {
      campaign_id: { type: "string", description: "Meta campaign id." },
      fields: { type: "string", description: "Comma-separated fields to include." },
    };
  }
  if (metaToolName === "meta_ads/list_ad_sets") {
    return {
      account_id: { type: "string", description: "Meta ad account id (used when campaign_id is omitted)." },
      campaign_id: { type: "string", description: "Optional campaign id to list its ad sets." },
      fields: { type: "string", description: "Comma-separated ad set fields." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Ad sets to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (metaToolName === "meta_ads/list_ads") {
    return {
      account_id: { type: "string", description: "Meta ad account id (used when campaign_id/adset_id are omitted)." },
      campaign_id: { type: "string", description: "Optional campaign id." },
      adset_id: { type: "string", description: "Optional ad set id." },
      fields: { type: "string", description: "Comma-separated ad fields." },
      limit: { type: "number", minimum: 1, maximum: 500, description: "Ads to return." },
      after: { type: "string", description: "Graph API paging cursor." },
    };
  }
  if (metaToolName === "meta_ads/get_insights") {
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
  if (metaToolName === "meta_ads/create_campaign") {
    return {
      account_id: { type: "string", description: "Meta ad account id, with or without the act_ prefix." },
      campaign: { type: "object", description: "Campaign object, e.g. { name, objective, status, special_ad_categories }." },
    };
  }
  if (metaToolName === "meta_ads/update_campaign") {
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
    const providerKey = toolName.split("/", 1)[0] ?? "";
    const methods = PROVIDERS[providerKey]?.genericRequest?.defaultMethods?.length
      ? PROVIDERS[providerKey].genericRequest!.defaultMethods
      : ["GET", "POST", "PUT", "PATCH", "DELETE"];
    // Advertising the host keys inline saves the agent a list_capabilities
    // round-trip just to learn that an upload/video host exists.
    const baseUrlKeys = Object.keys(PROVIDERS[providerKey]?.genericRequest?.baseUrls ?? {});
    return {
      path: { type: "string", description: "Provider API path relative to the provider base URL. Full URLs are rejected." },
      method: { type: "string", enum: methods, description: "HTTP method. Defaults to GET. Provider API permissions are enforced by the connected credential." },
      base_url_key: baseUrlKeys.length
        ? {
            type: "string",
            enum: baseUrlKeys,
            description: `Optional alternate API host for this provider. One of: ${baseUrlKeys.join(", ")}. Omit for the default host.`,
          }
        : { type: "string", description: "Optional manifest-defined base URL key for providers with multiple API hosts. This provider exposes a single host, so omit it." },
      query: { type: "object", description: "Optional query parameters. Array values are repeated." },
      body: { type: "object", description: "Optional JSON request body for POST/PUT/PATCH/DELETE. Alias: data or json." },
      data: { type: "object", description: "Alias for body." },
      files: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            field: { type: "string", description: "Multipart field name the provider expects, e.g. file." },
            file_id: { type: "string", description: "Id returned by POST /files on this grantry host." },
            filename: { type: "string", description: "Optional filename override." },
            content_type: { type: "string", description: "Optional content type override." },
          },
        },
        description: "Attach previously uploaded files, turning this into a multipart/form-data request; `body` entries become form fields. Upload first with `curl -H 'Authorization: Bearer gn_agt_...' -F file=@path https://<grantry-host>/files`, then pass the returned file_id here — the bytes go straight from grantry to the provider and never travel through the model's context.",
      },
      headers: { type: "object", description: "Optional extra scalar headers. Authorization/Cookie/Host/Content-Length cannot be overridden." },
      timeout_ms: { type: "number", minimum: 1000, maximum: 120000, description: "Optional request timeout in milliseconds for this call. Defaults to the provider's own timeout. Raise it for reporting or query endpoints that are legitimately slow." },
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
  if (toolName === "youtube/create_upload_session") {
    return {
      title: { type: "string", description: "Video title." },
      description: { type: "string", description: "Optional video description." },
      tags: { type: "array", items: { type: "string" }, description: "Optional video tags." },
      category_id: { type: "string", description: "YouTube category id. Defaults to 22 (People & Blogs)." },
      privacy_status: { type: "string", enum: ["private", "public", "unlisted"], description: "Visibility of the finished video. Defaults to private." },
      publish_at: { type: "string", description: "Optional ISO 8601 timestamp to publish at. Only applies while privacy_status is private." },
      made_for_kids: { type: "boolean", description: "Optional self-declared made-for-kids flag." },
      notify_subscribers: { type: "boolean", description: "Optional: notify subscribers when the video is published." },
      content_type: { type: "string", description: "MIME type of the file you will upload, e.g. video/mp4. Defaults to video/*." },
      content_length: { type: "number", minimum: 1, description: "Optional byte size of the file, sent as X-Upload-Content-Length." },
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
  // --- apollo ---
  if (toolName === "apollo/health") { return {}; }
  if (toolName === "apollo/search_people") {
    return {
      data: { type: "object", description: "Raw Apollo people-search body. Overrides the convenience params below." },
      q_keywords: { type: "string", description: "Free-text keyword filter." },
      person_titles: { type: "array", items: { type: "string" }, description: "Job titles to match, e.g. [\"VP of Sales\"]." },
      person_seniorities: { type: "array", items: { type: "string" }, description: "Seniority levels, e.g. [\"vp\",\"director\"]." },
      person_locations: { type: "array", items: { type: "string" }, description: "Person locations, e.g. [\"Tokyo, Japan\"]." },
      organization_locations: { type: "array", items: { type: "string" }, description: "Company HQ locations." },
      organization_domains: { type: "array", items: { type: "string" }, description: "Company domains to scope to." },
      organization_num_employees_ranges: { type: "array", items: { type: "string" }, description: "Headcount ranges, e.g. [\"1,10\",\"11,50\"]." },
      contact_email_status: { type: "array", items: { type: "string" }, description: "Email status filter, e.g. [\"verified\"]." },
      page: { type: "number", description: "Page number (1-based)." },
      per_page: { type: "number", description: "Results per page (max 100)." },
    };
  }
  if (toolName === "apollo/enrich_person") {
    return {
      data: { type: "object", description: "Raw Apollo people/match body. Overrides the convenience params below." },
      first_name: { type: "string", description: "First name." },
      last_name: { type: "string", description: "Last name." },
      name: { type: "string", description: "Full name (alternative to first/last)." },
      email: { type: "string", description: "Known email to match on." },
      organization_name: { type: "string", description: "Company name." },
      domain: { type: "string", description: "Company domain." },
      linkedin_url: { type: "string", description: "LinkedIn profile URL." },
      reveal_personal_emails: { type: "boolean", description: "Reveal personal emails (consumes credits)." },
      reveal_phone_number: { type: "boolean", description: "Reveal phone number (consumes credits)." },
    };
  }
  if (toolName === "apollo/search_organizations") {
    return {
      data: { type: "object", description: "Raw Apollo organization-search body. Overrides the convenience params below." },
      q_organization_name: { type: "string", description: "Organization name keyword." },
      organization_locations: { type: "array", items: { type: "string" }, description: "Company locations." },
      organization_num_employees_ranges: { type: "array", items: { type: "string" }, description: "Headcount ranges, e.g. [\"1,10\"]." },
      organization_industry_tag_ids: { type: "array", items: { type: "string" }, description: "Apollo industry tag IDs." },
      q_organization_keyword_tags: { type: "array", items: { type: "string" }, description: "Keyword tags." },
      page: { type: "number", description: "Page number (1-based)." },
      per_page: { type: "number", description: "Results per page (max 100)." },
    };
  }
  if (toolName === "apollo/enrich_organization") {
    return {
      domain: { type: "string", description: "Company domain to enrich, e.g. apollo.io." },
    };
  }
  if (toolName === "apollo/search_contacts") {
    return {
      data: { type: "object", description: "Raw Apollo contacts/search body. Overrides the convenience params below." },
      q_keywords: { type: "string", description: "Free-text keyword filter." },
      contact_stage_id: { type: "string", description: "Filter by contact stage id." },
      sort_by_field: { type: "string", description: "Field to sort by." },
      sort_ascending: { type: "boolean", description: "Sort ascending when true." },
      page: { type: "number", description: "Page number (1-based)." },
      per_page: { type: "number", description: "Results per page (max 100)." },
    };
  }
  if (toolName === "apollo/create_contact") {
    return {
      data: { type: "object", description: "Raw Apollo contact body. Overrides the convenience fields below." },
      first_name: { type: "string", description: "First name." },
      last_name: { type: "string", description: "Last name." },
      email: { type: "string", description: "Contact email." },
      title: { type: "string", description: "Job title." },
      organization_name: { type: "string", description: "Company name." },
      website_url: { type: "string", description: "Company website." },
      label_names: { type: "array", items: { type: "string" }, description: "List/label names to apply." },
      present_raw_address: { type: "string", description: "Raw location string." },
      direct_phone: { type: "string", description: "Direct phone number." },
      mobile_phone: { type: "string", description: "Mobile phone number." },
    };
  }
  if (toolName === "apollo/update_contact") {
    return {
      contact_id: { type: "string", description: "Apollo contact id to update." },
      data: { type: "object", description: "Raw Apollo contact body. Overrides the convenience fields below." },
      first_name: { type: "string", description: "First name." },
      last_name: { type: "string", description: "Last name." },
      email: { type: "string", description: "Contact email." },
      title: { type: "string", description: "Job title." },
      organization_name: { type: "string", description: "Company name." },
      website_url: { type: "string", description: "Company website." },
      label_names: { type: "array", items: { type: "string" }, description: "List/label names to apply." },
      present_raw_address: { type: "string", description: "Raw location string." },
      direct_phone: { type: "string", description: "Direct phone number." },
      mobile_phone: { type: "string", description: "Mobile phone number." },
    };
  }
  if (toolName === "apollo/search_sequences") {
    return {
      data: { type: "object", description: "Raw Apollo emailer_campaigns/search body. Overrides the convenience params below." },
      q_name: { type: "string", description: "Sequence name keyword." },
      page: { type: "number", description: "Page number (1-based)." },
      per_page: { type: "number", description: "Results per page (max 100)." },
    };
  }
  if (toolName === "apollo/add_contacts_to_sequence") {
    return {
      sequence_id: { type: "string", description: "Apollo sequence (emailer_campaign) id." },
      contact_ids: { type: "array", items: { type: "string" }, description: "Apollo contact ids to add to the sequence." },
      send_email_from_email_account_id: { type: "string", description: "Mailbox id to send from (required by some Apollo plans)." },
      sequence_active_in_other_campaigns: { type: "boolean", description: "Allow contacts already active in other sequences." },
      data: { type: "object", description: "Raw body override." },
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
  if (toolName === "smartlead/check_connection" || toolName === "smartlead/list_campaigns" || toolName === "smartlead/list_email_accounts") {
    return {};
  }
  if (
    toolName === "smartlead/get_campaign" ||
    toolName === "smartlead/get_campaign_analytics" ||
    toolName === "smartlead/get_campaign_statistics"
  ) {
    return {
      campaign_id: { type: "string", description: "Smartlead campaign ID." },
    };
  }
  if (toolName === "smartlead/create_campaign") {
    return {
      name: { type: "string", description: "New Smartlead campaign name." },
      client_id: { type: "string", description: "Optional Smartlead client ID to attach the campaign to." },
      data: { type: "object", description: "Raw Smartlead create-campaign request body; overrides name/client_id." },
    };
  }
  if (toolName === "smartlead/update_campaign_status") {
    return {
      campaign_id: { type: "string", description: "Smartlead campaign ID." },
      status: { type: "string", enum: ["START", "PAUSED", "STOPPED"], description: "New campaign status." },
      data: { type: "object", description: "Raw Smartlead status request body; overrides status." },
    };
  }
  if (toolName === "smartlead/save_sequence") {
    return {
      campaign_id: { type: "string", description: "Smartlead campaign ID." },
      sequences: { type: "array", items: { type: "object" }, description: "Sequence steps to save. Use raw Smartlead sequence fields." },
      data: { type: "object", description: "Raw Smartlead sequences request body; overrides sequences." },
    };
  }
  if (toolName === "smartlead/add_leads_to_campaign") {
    return {
      campaign_id: { type: "string", description: "Smartlead campaign ID." },
      lead_list: { type: "array", items: { type: "object" }, description: "Leads to add. Use raw Smartlead lead fields." },
      settings: { type: "object", description: "Optional Smartlead lead-upload settings." },
      data: { type: "object", description: "Raw Smartlead add-leads request body; overrides lead_list/settings." },
    };
  }
  if (toolName === "smartlead/list_campaign_leads") {
    return {
      campaign_id: { type: "string", description: "Smartlead campaign ID." },
      offset: { type: "number", minimum: 0, description: "Pagination offset." },
      limit: { type: "number", minimum: 1, maximum: 100, description: "Leads to return, max 100." },
    };
  }
  if (toolName === "smartlead/get_message_history") {
    return {
      campaign_id: { type: "string", description: "Smartlead campaign ID." },
      lead_id: { type: "string", description: "Smartlead lead ID." },
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
  // --- channel_talk ---
  if (toolName === "channel_talk/list_managers") {
    return {
      limit: { type: "number", description: "Max managers to return (pagination)." },
      since: { type: "string", description: "Pagination cursor (the previous response's next value)." },
      sortOrder: { type: "string", description: "Sort order, e.g. asc or desc." },
    };
  }
  if (toolName === "channel_talk/get_manager") {
    return { manager_id: { type: "string", description: "Channel Talk manager ID." } };
  }
  if (toolName === "channel_talk/list_user_chats") {
    return {
      state: { type: "string", description: "Filter by chat state, e.g. opened, closed, snoozed." },
      sortOrder: { type: "string", description: "Sort order, e.g. asc or desc." },
      limit: { type: "number", description: "Max user-chats to return (pagination)." },
      since: { type: "string", description: "Pagination cursor (the previous response's next value)." },
    };
  }
  if (toolName === "channel_talk/get_user_chat") {
    return { user_chat_id: { type: "string", description: "Channel Talk user-chat ID." } };
  }
  if (toolName === "channel_talk/list_messages") {
    return {
      user_chat_id: { type: "string", description: "Channel Talk user-chat ID." },
      limit: { type: "number", description: "Max messages to return (pagination)." },
      since: { type: "string", description: "Pagination cursor (the previous response's next value)." },
      sortOrder: { type: "string", description: "Sort order, e.g. asc or desc." },
    };
  }
  if (toolName === "channel_talk/send_message") {
    return {
      user_chat_id: { type: "string", description: "Channel Talk user-chat ID to post into." },
      plain_text: { type: "string", description: "Message text (required unless blocks is supplied)." },
      blocks: { type: "array", description: "Optional Channel Talk rich message blocks; overrides/augments plain_text." },
      bot_name: { type: "string", description: "Optional bot name to attribute the message to (botName query param)." },
    };
  }
  if (toolName === "channel_talk/get_user") {
    return { user_id: { type: "string", description: "Channel Talk user ID." } };
  }
  if (toolName === "channel_talk_documents/list_articles") {
    return {
      language: { type: "string", description: "Language code of the articles to list, e.g. ja, ko, en (required by the API)." },
      state: { type: "string", description: "Filter by state: published, unpublished, or draft." },
      topic_id: { type: "string", description: "Filter to a single topic (folder) id." },
      limit: { type: "number", description: "Max articles to return (default 25)." },
      since: { type: "string", description: "Pagination cursor (the previous response's next value)." },
      order: { type: "string", description: "Sort order: asc or desc." },
    };
  }
  if (toolName === "channel_talk_documents/get_article") {
    return {
      article_id: { type: "string", description: "Article id or slug." },
      language: { type: "string", description: "Language code of the article, e.g. ja (required by the API)." },
    };
  }
  if (toolName === "channel_talk_documents/create_article") {
    return {
      title: { type: "string", description: "Article title." },
      content: { type: "string", description: "Article body content." },
      description: { type: "string", description: "Short summary/preview text." },
      language: { type: "string", description: "Language code, e.g. ja, ko, en." },
      topic_id: { type: "string", description: "Topic (folder) id to file the article under. Use list_topics to find it." },
      slug: { type: "string", description: "Optional URL-friendly slug." },
      state: { type: "string", description: "published, unpublished, or draft." },
      data: { type: "object", description: "Optional raw request body; merged last and overrides the convenience fields above. Use this if the space needs body fields not covered here." },
    };
  }
  if (toolName === "channel_talk_documents/delete_article") {
    return { article_id: { type: "string", description: "Article id to delete." } };
  }
  if (toolName === "channel_talk_documents/list_topics") {
    return {
      limit: { type: "number", description: "Max topics to return (default 25)." },
      since: { type: "string", description: "Pagination cursor (the previous response's next value)." },
      order: { type: "string", description: "Sort order: asc or desc." },
    };
  }
  if (toolName === "channel_talk_documents/get_topic") {
    return { topic_id: { type: "string", description: "Topic (folder) id." } };
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
  if (toolName === "granola/list_notes") {
    return {
      created_after: { type: "string", description: "Only notes created after this ISO 8601 timestamp." },
      created_before: { type: "string", description: "Only notes created before this ISO 8601 timestamp." },
      updated_after: { type: "string", description: "Only notes updated after this ISO 8601 timestamp." },
      folder_id: { type: "string", description: "Restrict to notes in this folder and its child folders." },
      cursor: { type: "string", description: "Pagination cursor from a previous list_notes response." },
      page_size: { type: "integer", description: "Number of notes to return per page." },
    };
  }
  if (toolName === "granola/get_note") {
    return {
      note_id: { type: "string", description: "Granola note ID." },
      include: { type: "string", enum: ["transcript"], description: "Set to 'transcript' to include the meeting transcript in the response." },
    };
  }
  if (toolName === "granola/list_folders") {
    return {
      cursor: { type: "string", description: "Pagination cursor from a previous list_folders response." },
      page_size: { type: "integer", description: "Number of folders to return per page." },
    };
  }
  if (toolName === "tldv/list_meetings") {
    return {
      query: { type: "string", description: "Free-text search over meeting names." },
      page: { type: "integer", description: "1-based page number." },
      limit: { type: "integer", description: "Results per page (tl;dv defaults to 50)." },
      from: { type: "string", description: "Only meetings that happened after this ISO 8601 timestamp." },
      to: { type: "string", description: "Only meetings that happened before this ISO 8601 timestamp." },
      only_participated: { type: "boolean", description: "When true, only meetings the API key's user attended." },
      meeting_type: { type: "string", enum: ["internal", "external"], description: "Filter by meeting type, derived from organizer vs invitee email domains." },
    };
  }
  if (toolName === "tldv/get_meeting") {
    return {
      meeting_id: { type: "string", description: "tl;dv meeting id (from list_meetings)." },
    };
  }
  if (toolName === "tldv/get_transcript") {
    return {
      meeting_id: { type: "string", description: "tl;dv meeting id. Returns the full transcript with speaker, text and timestamps." },
    };
  }
  if (toolName === "tldv/get_notes") {
    return {
      meeting_id: { type: "string", description: "tl;dv meeting id. Returns AI notes as markdown plus structured notes and topics." },
    };
  }
  if (toolName === "tldv/get_highlights") {
    return {
      meeting_id: { type: "string", description: "tl;dv meeting id. Deprecated by tl;dv in favour of tldv/get_notes." },
    };
  }
  if (toolName === "tldv/get_download_url") {
    return {
      meeting_id: { type: "string", description: "tl;dv meeting id. Returns a signed, expiring URL for the recording file instead of streaming it." },
    };
  }
  if (toolName === "tldv/import_meeting") {
    return {
      url: { type: "string", description: "Publicly accessible URL of the recording/media to import." },
      name: { type: "string", description: "Name for the imported meeting, e.g. \"1:1 John x Sarah\"." },
      data: { type: "object", description: "Optional extra fields merged into the import request body." },
    };
  }
  if (toolName.startsWith("zapmail/")) {
    // Every Zapmail call may be pointed at another workspace than the one pinned on the connection.
    const workspace = {
      workspace_key: { type: "string", description: "Optional workspace ID to act on (x-workspace-key). Defaults to the workspace pinned on the connection, else the primary one." },
      service_provider: { type: "string", enum: ["GOOGLE", "MICROSOFT"], description: "Optional mailbox service provider (x-service-provider)." },
    };
    const paging = {
      page: { type: "integer", description: "1-based page number." },
      limit: { type: "integer", description: "Results per page." },
    };
    if (toolName === "zapmail/get_user") return { ...workspace };
    if (toolName === "zapmail/list_workspaces") return { ...paging, search: { type: "string", description: "Filter workspaces by name." }, ...workspace };
    if (toolName === "zapmail/list_mailboxes") {
      return {
        ...paging,
        contains: { type: "string", description: "Filter mailboxes by substring, e.g. a domain like example.com." },
      include_secrets: { type: "boolean", description: "Return mailbox passwords, app passwords and TOTP secrets in clear text. Off by default - they are masked so a listing does not leak account credentials. Only set this when the credentials themselves are the point of the call." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/get_mailbox") {
      return {
        mailbox_id: { type: "string", description: "Zapmail mailbox id." },
      include_secrets: { type: "boolean", description: "Return mailbox passwords, app passwords and TOTP secrets in clear text. Off by default - they are masked so a listing does not leak account credentials. Only set this when the credentials themselves are the point of the call." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/list_domains") return { ...paging, contains: { type: "string", description: "Filter domains by substring." }, ...workspace };
    if (toolName === "zapmail/list_assignable_domains") return { ...paging, contains: { type: "string", description: "Filter domains by substring." }, ...workspace };
    if (toolName === "zapmail/search_domains") {
      return {
        domain_name: { type: "string", description: "Name to price, e.g. \"onestream-hq.com\" or a bare keyword. Returns the exact match plus similar available names." },
        tlds: { type: "array", items: { type: "string" }, description: "TLDs to search, e.g. [\"com\", \"io\"]. Defaults to Zapmail's own selection." },
        years: { type: "integer", description: "Registration length used for pricing. Defaults to 1." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/check_domains") {
      return {
        domain_names: { type: "array", items: { type: "string" }, description: "Up to 20 exact domain names to check for availability and price." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/ai_find_domains") {
      return {
        keywords: { type: "array", items: { type: "string" }, description: "Keywords the generated names should build on." },
        tlds: { type: "array", items: { type: "string" }, description: "TLDs to generate against. Defaults to [\"com\"]." },
        desired_count: { type: "integer", description: "How many available names to return. Defaults to 10." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/get_name_servers") {
      return {
        domain_name: { type: "string", description: "Domain you already own, e.g. \"example.jp\". Returns the nameservers to set at its registrar." },
        mask_forwarding: { type: "boolean", description: "Mask the forwarding target so visitors keep seeing this domain in the address bar. Defaults to false; Zapmail requires the field either way." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/verify_name_servers") {
      return {
        domain_name: { type: "string", description: "Domain whose nameserver change should be checked for propagation." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/connect_domain") {
      return {
        domain_names: { type: "array", items: { type: "string" }, description: "Domains to finish connecting, once their nameservers verify." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/list_connection_requests") return { ...paging, ...workspace };
    if (toolName === "zapmail/assign_mailboxes") {
      return {
        domain_id: { type: "string", description: "Zapmail domain id from zapmail/list_assignable_domains." },
        domain_name: { type: "string", description: "The domain itself, e.g. \"example.com\"." },
        mailboxes: {
          type: "array",
          description: "Mailboxes to create. Draws on the plan's prepaid quota; the call is refused when more are requested than remain unassigned.",
          items: {
            type: "object",
            properties: {
              username: { type: "string", description: "Local part, e.g. \"sample-user\" for sample-user@example.com." },
              first_name: { type: "string", description: "Display first name." },
              last_name: { type: "string", description: "Display last name." },
            },
            required: ["username", "first_name", "last_name"],
          },
        },
        ...workspace,
      };
    }
    if (toolName === "zapmail/add_dmarc") {
      return {
        domain_ids: { type: "array", items: { type: "string" }, description: "Domains to add a DMARC record to." },
        email: { type: "string", description: "Address that receives DMARC aggregate reports." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/add_forwarding") {
      return {
        domain_ids: { type: "array", items: { type: "string" }, description: "Domains to forward." },
        forward_to: { type: "string", description: "Destination the domain redirects to, e.g. \"https://example.com/\"." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/get_domain_health") return { domain_id: { type: "string", description: "Optional domain id. Omit to score every domain in the workspace." }, ...workspace };
    if (toolName === "zapmail/get_dns_records") return { domain_id: { type: "string", description: "Zapmail domain id (from zapmail/list_domains)." }, ...workspace };
    if (toolName === "zapmail/list_subscriptions") return { ...paging, ...workspace };
    if (toolName === "zapmail/get_wallet_balance") return { ...workspace };
    if (toolName === "zapmail/search") {
      return {
        contains: { type: "string", description: "Domain or mailbox email to look up." },
        ...paging,
      include_secrets: { type: "boolean", description: "Return mailbox passwords, app passwords and TOTP secrets in clear text. Off by default - they are masked so a listing does not leak account credentials. Only set this when the credentials themselves are the point of the call." },
        ...workspace,
      };
    }
    if (toolName === "zapmail/list_third_party_accounts") return { app: { type: "string", description: "Export app, e.g. SMARTLEAD, INSTANTLY, REACHINBOX, LEMLIST." }, ...workspace };
    if (toolName === "zapmail/get_export_status") return { export_id: { type: "string", description: "Export id returned by zapmail/export_mailboxes." }, ...workspace };
    if (toolName === "zapmail/export_mailboxes") {
      return {
        apps: { type: "array", items: { type: "string" }, description: "Target apps, e.g. [\"SMARTLEAD\"]. Also accepts REACHINBOX, INSTANTLY, LEMLIST, EMELIA, REPLY_IO, WARMY, SNOV, EMAILBISON and the other apps Zapmail supports." },
        ids: { type: "array", items: { type: "string" }, description: "Mailbox ids to export. Empty with a filter set exports everything the filter matches." },
        exclude_ids: { type: "array", items: { type: "string" }, description: "Mailbox ids to skip." },
        tag_ids: { type: "array", items: { type: "string" }, description: "Only mailboxes carrying these domain tags." },
        status: { type: "string", enum: ["ACTIVE", "IN_PROGRESS", "CREATING_PASSWORD", "EXPIRED", "FAILED"], description: "Only mailboxes in this status." },
        contains: { type: "string", description: "Only mailboxes matching this substring." },
        third_party_account_id: { type: "string", description: "Pin the export to one third-party account. Required when the workspace holds several accounts for the same app." },
        ...workspace,
      };
    }
    return { ...workspace };
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
      text: { type: "string", description: "Tweet text, max 280 characters. Optional if at least one image is attached." },
      image_urls: { type: "array", items: { type: "string" }, description: "Optional image URLs to download and attach (max 4 images total across all image inputs)." },
      image_base64: { type: "array", items: { type: "string" }, description: "Optional base64-encoded images to attach (data: URIs allowed). Counts toward the 4-image total." },
      media_ids: { type: "array", items: { type: "string" }, description: "Optional pre-uploaded X media IDs to attach." },
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
  // --- openai ---
  if (toolName === "openai/generate_image") {
    return {
      prompt: { type: "string", description: "Text description of the image to generate." },
      model: { type: "string", description: "Image model. Default dall-e-3 (returns a hosted URL). Use gpt-image-1 for the newest/higher-quality model (returns base64; requires OpenAI org verification)." },
      size: { type: "string", description: "Image size, e.g. 1024x1024. gpt-image-1: 1024x1024 | 1536x1024 | 1024x1536 | auto. dall-e-3: 1024x1024 | 1792x1024 | 1024x1792." },
      quality: { type: "string", description: "gpt-image-1: low | medium | high | auto. dall-e-3: standard | hd." },
      n: { type: "number", description: "Number of images to generate (dall-e-3 supports only 1)." },
      response_format: { type: "string", enum: ["url", "b64_json"], description: "DALL·E models only: return a hosted url (default) or base64. Ignored by gpt-image-1, which always returns base64." },
      style: { type: "string", enum: ["vivid", "natural"], description: "dall-e-3 only: rendering style." },
      background: { type: "string", enum: ["transparent", "opaque", "auto"], description: "gpt-image-1 only: background handling." },
      output_format: { type: "string", enum: ["png", "jpeg", "webp"], description: "gpt-image-1 only: output image format." },
      user: { type: "string", description: "Optional end-user identifier for abuse monitoring." },
    };
  }
  // --- openai_ads ---
  if (toolName === "openai_ads/get_ad_account") { return {}; }
  if (toolName === "openai_ads/list_campaigns") { return { query: { type: "object", description: "Optional query params, e.g. { limit, after }." } }; }
  if (toolName === "openai_ads/get_campaign") { return { campaign_id: { type: "string", description: "Campaign id." } }; }
  if (toolName === "openai_ads/list_ad_groups") { return { query: { type: "object", description: "Optional query params, e.g. { campaign_id, limit, after }." } }; }
  if (toolName === "openai_ads/get_ad_group") { return { ad_group_id: { type: "string", description: "Ad group id." } }; }
  if (toolName === "openai_ads/list_ads") { return { query: { type: "object", description: "Optional query params, e.g. { ad_group_id, limit, after }." } }; }
  if (toolName === "openai_ads/get_ad") { return { ad_id: { type: "string", description: "Ad id." } }; }
  if (toolName === "openai_ads/get_insights") {
    return {
      level: { type: "string", enum: ["ad_account", "campaign", "ad_group", "ad"], description: "Aggregation level. Default ad_account." },
      id: { type: "string", description: "Object id for campaign/ad_group/ad levels (not needed for ad_account)." },
      query: { type: "object", description: "Insights params, e.g. { time_granularity, fields: ['impressions','clicks','spend'], time_ranges, filters, sort, segments, limit }. Array values are repeated." },
    };
  }
  // --- higgsfield ---
  if (toolName === "higgsfield/generate_image") {
    return {
      prompt: { type: "string", description: "Text description of the image to generate." },
      model_id: { type: "string", description: "Model to use. Default higgsfield-ai/soul/standard. Browse the catalog at cloud.higgsfield.ai (e.g. reve/text-to-image)." },
      aspect_ratio: { type: "string", description: "Aspect ratio, e.g. 16:9, 4:3, 1:1, 9:16." },
      resolution: { type: "string", description: "Output resolution, e.g. 480p | 720p | 1080p (model-dependent)." },
      reference_image_urls: { type: "array", items: { type: "string" }, description: "Optional reference image URLs (Soul-style models) to guide style/content." },
      seed: { type: "number", description: "Optional seed for reproducibility." },
      params: { type: "object", description: "Any additional model-specific parameters, merged into the request body." },
    };
  }
  if (toolName === "higgsfield/generate_video") {
    return {
      prompt: { type: "string", description: "Motion/scene description. Alone = text-to-video; with image_url = image-to-video." },
      image_url: { type: "string", description: "Source image URL to animate (image-to-video). Optional if prompt is given." },
      model_id: { type: "string", description: "Model to use. Default higgsfield-ai/dop/standard. Other options e.g. kling-video/v2.1/pro/image-to-video, bytedance/seedance/v1/pro/image-to-video." },
      duration: { type: "number", description: "Video duration in seconds, e.g. 5 or 10 (model-dependent)." },
      aspect_ratio: { type: "string", description: "Aspect ratio for text-to-video, e.g. 16:9, 4:3, 1:1, 9:21." },
      resolution: { type: "string", description: "Output resolution, e.g. 480p | 720p | 1080p (model-dependent)." },
      seed: { type: "number", description: "Optional seed for reproducibility." },
      params: { type: "object", description: "Any additional model-specific parameters, merged into the request body." },
    };
  }
  if (toolName === "higgsfield/get_request") { return { request_id: { type: "string", description: "The request_id returned by a generate call. Returns current status plus images/video when completed." } }; }
  if (toolName === "higgsfield/cancel_request") { return { request_id: { type: "string", description: "The request_id to cancel. Only works while the job is still queued." } }; }
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

  // --- google_slides ---
  if (toolName === "google_slides/get_presentation") { return { presentation_id: { type: "string", description: "Presentation id." } }; }
  if (toolName === "google_slides/get_page") { return { presentation_id: { type: "string", description: "Presentation id." }, page_object_id: { type: "string", description: "Page (slide) object id." } }; }
  if (toolName === "google_slides/get_page_thumbnail") { return { presentation_id: { type: "string", description: "Presentation id." }, page_object_id: { type: "string", description: "Page (slide) object id." }, thumbnail_size: { type: "string", description: "LARGE, MEDIUM, or SMALL. Defaults to LARGE." } }; }
  if (toolName === "google_slides/create_presentation") { return { title: { type: "string", description: "New presentation title." } }; }
  if (toolName === "google_slides/batch_update") { return { presentation_id: { type: "string", description: "Presentation id." }, requests: { type: "array", items: { type: "object" }, description: "Slides API batchUpdate request objects (e.g. createSlide, insertText, replaceAllText)." }, write_control: { type: "object", description: "Optional writeControl (requiredRevisionId)." } }; }

  // --- google_forms ---
  if (toolName === "google_forms/get_form") { return { form_id: { type: "string", description: "Form id." } }; }
  if (toolName === "google_forms/create_form") { return { title: { type: "string", description: "New form title (shown to respondents)." }, document_title: { type: "string", description: "Optional Drive document title. Defaults to title." } }; }
  if (toolName === "google_forms/batch_update") { return { form_id: { type: "string", description: "Form id." }, requests: { type: "array", items: { type: "object" }, description: "Forms API batchUpdate request objects (e.g. createItem, updateItem, updateFormInfo, updateSettings)." }, include_form_in_response: { type: "boolean", description: "Return the updated form in the response." }, write_control: { type: "object", description: "Optional writeControl (requiredRevisionId)." } }; }
  if (toolName === "google_forms/list_responses") { return { form_id: { type: "string", description: "Form id." }, filter: { type: "string", description: "Optional filter, e.g. timestamp > 2026-07-01T00:00:00Z." }, page_size: { type: "number", description: "Max responses per page (up to 5000)." }, page_token: { type: "string", description: "Page token from a previous call." } }; }
  if (toolName === "google_forms/get_response") { return { form_id: { type: "string", description: "Form id." }, response_id: { type: "string", description: "Response id." } }; }

  // --- twenty ---
  if (toolName === "twenty/list_objects") { return {}; }
  if (toolName === "twenty/list_records") { return { object: { type: "string", description: "Plural object name, e.g. people, companies, opportunities, or a custom object." }, filter: { type: "string", description: "Optional filter, e.g. name[ilike]:%acme% or emails.primaryEmail[eq]:a@b.com." }, order_by: { type: "string", description: "Optional sort, e.g. createdAt[DescNullsLast]." }, limit: { type: "number", description: "Max records (up to 60)." }, starting_after: { type: "string", description: "Cursor from a previous page (endCursor)." }, depth: { type: "number", description: "Relation depth 0-2." } }; }
  if (toolName === "twenty/get_record") { return { object: { type: "string", description: "Plural object name." }, record_id: { type: "string", description: "Record id (uuid)." }, }; }
  if (toolName === "twenty/create_record") { return { object: { type: "string", description: "Plural object name." }, data: { type: "object", description: "Field values, e.g. { name: { firstName, lastName } } for people." } }; }
  if (toolName === "twenty/update_record") { return { object: { type: "string", description: "Plural object name." }, record_id: { type: "string", description: "Record id (uuid)." }, data: { type: "object", description: "Field values to update." } }; }

  // --- intent_engine ---
  if (toolName === "intent_engine/health") { return {}; }
  if (toolName === "intent_engine/list_signal_types") { return {}; }
  if (toolName === "intent_engine/search_signals") {
    return {
      q: { type: "string", description: "Keyword match against the company name, title and quoted evidence." },
      semantic: { type: "string", description: "Semantic search sentence, e.g. a description of the company you want. Only works when the deployment has embeddings." },
      type: { type: "string", description: "Signal type. Accepts the Japanese label or the raw signal_type — call intent_engine/list_signal_types for the vocabulary." },
      pref: { type: "string", description: "Prefecture, e.g. \u611b\u77e5\u770c." },
      tag: { type: "string", description: "Tag, e.g. subsidy. internal_only marks signals that must not be quoted in outbound writing." },
      min_strength: { type: "number", description: "Minimum strength, 1-5." },
      include_expired: { type: "string", description: "Set to \"1\" to include signals past their expiry. Default excludes them." },
      limit: { type: "number", description: "Max rows, default 50." },
      offset: { type: "number", description: "Row offset for paging." },
    };
  }
  if (toolName === "intent_engine/get_company") {
    return {
      key: { type: "string", description: "13-digit Japanese corporate number, jcn:<13 digits>, or a domain. Returns that company's signals plus its insured-employee history in one call." },
    };
  }
  if (toolName === "intent_engine/stacked_companies") {
    return {
      min: { type: "number", description: "Minimum number of overlapping live signals, default 2. Overlap is a stronger buying indicator than any single signal." },
      limit: { type: "number", description: "Max companies, default 100." },
    };
  }
  if (toolName === "intent_engine/headcount_changes") {
    return {
      direction: { type: "string", enum: ["shrank", "grew"], description: "Filter to companies whose insured-employee count fell or rose since the previous monthly cycle. Omit for both. Note: a fall is for internal scoring only — do not quote it back to the company." },
      min_diff: { type: "number", description: "Minimum absolute change in people, default 1." },
      pref: { type: "string", description: "Prefecture, exact match." },
      limit: { type: "number", description: "Max companies, default 50, max 500." },
    };
  }
  if (toolName === "intent_engine/insured_summary") { return {}; }

  // --- seminar_portal ---
  if (toolName === "seminar_portal/list_tech") { return {}; }
  if (toolName === "seminar_portal/search") {
    return {
      q: { type: "string", description: "Free text matched against title, organizer, summary and tags." },
      category: { type: "string", description: "One of AI, SaaS, Infra, IT." },
      tech: { type: "array", items: { type: "string" }, description: "Canonical technology names from seminar_portal/list_tech, e.g. [\"AWS\", \"生成AI\"]. A name outside that vocabulary matches nothing." },
      tech_match: { type: "string", description: "any (default) matches seminars carrying at least one of tech; all demands every one." },
      online: { type: "string", description: "\"true\" for online only, \"false\" for on-site only." },
      from: { type: "string", description: "ISO date; seminars starting on or after it." },
      to: { type: "string", description: "ISO date; seminars starting on or before it." },
      include_past: { type: "string", description: "\"true\" to include seminars that already happened. Upcoming only by default." },
      limit: { type: "number", description: "Max 100, default 20." },
      offset: { type: "number", description: "For paging; the response carries total." },
    };
  }
  if (toolName === "seminar_portal/get") { return { id: { type: "number", description: "Seminar id, as returned by search." } }; }
  if (toolName === "seminar_portal/recommend") {
    return {
      tech: { type: "array", items: { type: "string" }, description: "The person's technologies, as canonical names from seminar_portal/list_tech. Required. Names outside the vocabulary come back in ignored_interests rather than failing the call." },
      limit: { type: "number", description: "Max 50, default 10." },
    };
  }

  // --- nocodb ---
  if (toolName === "nocodb/get_me") { return {}; }
  if (toolName === "nocodb/list_bases") { return { workspace_id: { type: "string", description: "Optional NocoDB Cloud workspace id; omit on self-hosted instances." } }; }
  if (toolName === "nocodb/list_tables") { return { base_id: { type: "string", description: "NocoDB base id (p...)." } }; }
  if (toolName === "nocodb/get_table") { return { table_id: { type: "string", description: "NocoDB table id (m...); returns the table schema including columns." } }; }
  if (toolName === "nocodb/list_views") { return { table_id: { type: "string", description: "NocoDB table id (m...)." } }; }
  if (toolName === "nocodb/list_records") {
    return {
      table_id: { type: "string", description: "NocoDB table id (m...)." },
      view_id: { type: "string", description: "Optional view id (vw...) to apply that view's filters and sorts." },
      fields: { type: "string", description: "Comma-separated field names to return." },
      sort: { type: "string", description: "Comma-separated sort, e.g. Title,-CreatedAt (leading - = descending)." },
      where: { type: "string", description: "NocoDB filter expression, e.g. (Status,eq,Active)." },
      limit: { type: "number", description: "Max records per page (default 25, max 1000)." },
      offset: { type: "number", description: "Records to skip for pagination." },
    };
  }
  if (toolName === "nocodb/count_records") { return { table_id: { type: "string", description: "NocoDB table id (m...)." }, view_id: { type: "string", description: "Optional view id." }, where: { type: "string", description: "NocoDB filter expression, e.g. (Status,eq,Active)." } }; }
  if (toolName === "nocodb/get_record") { return { table_id: { type: "string", description: "NocoDB table id (m...)." }, record_id: { type: "string", description: "Record primary key (Id)." }, fields: { type: "string", description: "Comma-separated field names to return." } }; }
  if (toolName === "nocodb/create_records") { return { table_id: { type: "string", description: "NocoDB table id (m...)." }, fields: { type: "object", description: "Field values for a single new record." }, records: { type: "array", items: { type: "object" }, description: "Array of field-value objects to insert in bulk (alternative to fields)." } }; }
  if (toolName === "nocodb/update_records") { return { table_id: { type: "string", description: "NocoDB table id (m...)." }, record_id: { type: "string", description: "Record primary key (Id) to update, when using fields." }, fields: { type: "object", description: "Field values to update on record_id." }, records: { type: "array", items: { type: "object" }, description: "Array of objects, each carrying Id plus the fields to update (bulk alternative)." } }; }
  if (toolName === "nocodb/delete_records") { return { table_id: { type: "string", description: "NocoDB table id (m...)." }, record_id: { type: "string", description: "Record primary key (Id) to delete." }, records: { type: "array", items: { type: "object" }, description: "Array of { Id } objects to delete in bulk (alternative to record_id)." } }; }

  // --- langgraph ---
  if (toolName === "langgraph/get_info") { return {}; }
  if (toolName === "langgraph/search_assistants") { return { graph_id: { type: "string", description: "Only assistants for this graph id." }, name: { type: "string", description: "Assistant name to match." }, metadata: { type: "object", description: "Metadata key/values every returned assistant must carry." }, limit: { type: "number", description: "Max assistants to return (default 20)." }, offset: { type: "number", description: "Assistants to skip for pagination." } }; }
  if (toolName === "langgraph/get_assistant") { return { assistant_id: { type: "string", description: "Assistant id (uuid) or graph id." } }; }
  if (toolName === "langgraph/get_assistant_schemas") { return { assistant_id: { type: "string", description: "Assistant id (uuid) or graph id; returns the input, output, state, and config JSON schemas." } }; }
  if (toolName === "langgraph/search_threads") { return { metadata: { type: "object", description: "Metadata key/values every returned thread must carry." }, status: { type: "string", description: "Thread status: idle, busy, interrupted, or error." }, values: { type: "object", description: "State values every returned thread must match." }, limit: { type: "number", description: "Max threads to return (default 20)." }, offset: { type: "number", description: "Threads to skip for pagination." } }; }
  if (toolName === "langgraph/create_thread") { return { thread_id: { type: "string", description: "Optional client-supplied thread id (uuid)." }, metadata: { type: "object", description: "Metadata to attach to the thread." }, if_exists: { type: "string", description: "Behaviour when thread_id already exists: raise (default) or do_nothing." } }; }
  if (toolName === "langgraph/get_thread") { return { thread_id: { type: "string", description: "Thread id (uuid)." } }; }
  if (toolName === "langgraph/get_thread_state") { return { thread_id: { type: "string", description: "Thread id (uuid)." }, checkpoint_id: { type: "string", description: "Optional checkpoint id; omit for the latest state." } }; }
  if (toolName === "langgraph/get_thread_history") { return { thread_id: { type: "string", description: "Thread id (uuid)." }, limit: { type: "number", description: "Max checkpoints to return (default 10)." }, before: { type: "string", description: "Return checkpoints before this checkpoint id." }, metadata: { type: "object", description: "Only checkpoints whose metadata matches." } }; }
  if (toolName === "langgraph/list_runs") { return { thread_id: { type: "string", description: "Thread id (uuid)." }, limit: { type: "number", description: "Max runs to return." }, offset: { type: "number", description: "Runs to skip for pagination." } }; }
  if (toolName === "langgraph/get_run") { return { thread_id: { type: "string", description: "Thread id (uuid)." }, run_id: { type: "string", description: "Run id (uuid)." } }; }
  if (toolName === "langgraph/create_run") { return { thread_id: { type: "string", description: "Thread id (uuid) to run on. Omit for a stateless background run." }, assistant_id: { type: "string", description: "Assistant id (uuid) or graph id to invoke." }, input: { type: "object", description: "Graph input, e.g. { messages: [{ role: \"user\", content: \"...\" }] }." }, config: { type: "object", description: "Run config, e.g. { configurable: { model: \"...\" } }." }, metadata: { type: "object", description: "Metadata to attach to the run." }, webhook: { type: "string", description: "URL called when the run finishes." }, interrupt_before: { description: "Node names to interrupt before (array, or the string \"*\")." }, interrupt_after: { description: "Node names to interrupt after (array, or the string \"*\")." }, multitask_strategy: { type: "string", description: "How to handle a busy thread: reject, rollback, interrupt, or enqueue." } }; }
  if (toolName === "langgraph/run_wait") { return { thread_id: { type: "string", description: "Thread id (uuid). Omit for a stateless run that keeps no checkpoint." }, assistant_id: { type: "string", description: "Assistant id (uuid) or graph id to invoke." }, input: { type: "object", description: "Graph input, e.g. { messages: [{ role: \"user\", content: \"...\" }] }." }, config: { type: "object", description: "Run config, e.g. { configurable: { model: \"...\" } }." }, metadata: { type: "object", description: "Metadata to attach to the run." }, interrupt_before: { description: "Node names to interrupt before (array, or the string \"*\")." }, interrupt_after: { description: "Node names to interrupt after (array, or the string \"*\")." }, multitask_strategy: { type: "string", description: "How to handle a busy thread: reject, rollback, interrupt, or enqueue." } }; }
  if (toolName === "langgraph/cancel_run") { return { thread_id: { type: "string", description: "Thread id (uuid)." }, run_id: { type: "string", description: "Run id (uuid)." }, wait: { type: "boolean", description: "Block until the run actually stops." }, action: { type: "string", description: "interrupt (default) or rollback." } }; }
  if (toolName === "langgraph/search_crons") { return { assistant_id: { type: "string", description: "Only crons for this assistant id." }, thread_id: { type: "string", description: "Only crons bound to this thread id." }, limit: { type: "number", description: "Max crons to return (default 20)." }, offset: { type: "number", description: "Crons to skip for pagination." } }; }
  if (toolName === "langgraph/delete_cron") { return { cron_id: { type: "string", description: "Cron id (uuid) to delete." } }; }
  if (toolName === "langgraph/search_store_items") { return { namespace_prefix: { type: "array", items: { type: "string" }, description: "Namespace path prefix, e.g. [\"memories\", \"user-1\"]." }, filter: { type: "object", description: "Key/value filter over item values." }, query: { type: "string", description: "Natural-language query for semantic search, when the store has an index." }, limit: { type: "number", description: "Max items to return (default 20)." }, offset: { type: "number", description: "Items to skip for pagination." } }; }

  // --- langsmith ---
  if (toolName === "langsmith/list_workspaces") { return {}; }
  if (toolName === "langsmith/list_projects") { return { name: { type: "string", description: "Exact tracing project name." }, name_contains: { type: "string", description: "Substring match on the project name." }, limit: { type: "number", description: "Max projects to return (default 20)." }, offset: { type: "number", description: "Projects to skip for pagination." } }; }
  if (toolName === "langsmith/get_project") { return { project_id: { type: "string", description: "Tracing project (session) id (uuid)." } }; }
  if (toolName === "langsmith/query_runs") {
    return {
      session: { type: "string", description: "Tracing project id (uuid) to search within." },
      filter: { type: "string", description: "LangSmith filter expression, e.g. eq(run_type, \"llm\") or and(eq(status, \"error\"), gt(latency, 5))." },
      trace_filter: { type: "string", description: "Filter applied to the root run of each trace." },
      tree_filter: { type: "string", description: "Filter applied to any run in the trace tree." },
      run_type: { type: "string", description: "Run type, e.g. llm, chain, tool, retriever." },
      is_root: { type: "boolean", description: "Only root runs (whole traces) when true." },
      trace: { type: "string", description: "Trace id (uuid) to return every run of one trace." },
      parent_run: { type: "string", description: "Parent run id (uuid)." },
      start_time: { type: "string", description: "ISO 8601 lower bound on run start time." },
      end_time: { type: "string", description: "ISO 8601 upper bound on run end time." },
      error: { type: "boolean", description: "Only errored runs when true; only successful runs when false." },
      select: { type: "array", items: { type: "string" }, description: "Fields to return, e.g. [\"id\",\"name\",\"status\",\"latency\"]. Trims large inputs/outputs." },
      order: { type: "string", description: "Sort order, e.g. desc (default) or asc by start time." },
      limit: { type: "number", description: "Max runs to return (default 20)." },
      cursor: { type: "string", description: "Pagination cursor returned by a previous query." },
    };
  }
  if (toolName === "langsmith/get_run") { return { run_id: { type: "string", description: "Run id (uuid)." } }; }
  if (toolName === "langsmith/list_datasets") { return { name: { type: "string", description: "Exact dataset name." }, name_contains: { type: "string", description: "Substring match on the dataset name." }, data_type: { type: "string", description: "Dataset data type, e.g. kv, llm, chat." }, limit: { type: "number", description: "Max datasets to return." }, offset: { type: "number", description: "Datasets to skip for pagination." } }; }
  if (toolName === "langsmith/get_dataset") { return { dataset_id: { type: "string", description: "Dataset id (uuid)." } }; }
  if (toolName === "langsmith/list_examples") { return { dataset_id: { type: "string", description: "Dataset id (uuid)." }, splits: { type: "string", description: "Comma-separated split names to filter by." }, full_text_contains: { type: "string", description: "Full-text search over example content." }, filter: { type: "string", description: "LangSmith filter expression over example metadata." }, limit: { type: "number", description: "Max examples to return." }, offset: { type: "number", description: "Examples to skip for pagination." } }; }
  if (toolName === "langsmith/create_examples") { return { dataset_id: { type: "string", description: "Dataset id (uuid) the examples belong to." }, inputs: { type: "object", description: "Inputs for a single new example." }, outputs: { type: "object", description: "Reference outputs for the single new example." }, metadata: { type: "object", description: "Metadata for the single new example." }, examples: { type: "array", items: { type: "object" }, description: "Array of { inputs, outputs?, metadata? } objects to create in bulk (alternative to inputs)." } }; }
  if (toolName === "langsmith/list_feedback") { return { run_id: { type: "string", description: "Only feedback attached to this run id (uuid)." }, project_id: { type: "string", description: "Only feedback within this tracing project id (uuid)." }, key: { type: "string", description: "Feedback key, e.g. correctness." }, limit: { type: "number", description: "Max feedback rows to return." }, offset: { type: "number", description: "Rows to skip for pagination." } }; }
  if (toolName === "langsmith/create_feedback") { return { run_id: { type: "string", description: "Run id (uuid) to attach the feedback to." }, key: { type: "string", description: "Feedback key, e.g. correctness." }, score: { type: "number", description: "Numeric score, typically 0-1." }, value: { description: "Categorical feedback value (string, number, or boolean)." }, comment: { type: "string", description: "Free-text comment." } }; }
  if (toolName === "langsmith/list_prompts") { return { query: { type: "string", description: "Search text matched against prompt names and descriptions." }, is_public: { type: "boolean", description: "Restrict to public (true) or private (false) prompts." }, limit: { type: "number", description: "Max prompts to return." }, offset: { type: "number", description: "Prompts to skip for pagination." } }; }
  if (toolName === "langsmith/get_prompt") { return { owner: { type: "string", description: "Prompt owner handle, or - for the current workspace." }, repo: { type: "string", description: "Prompt (repo) handle." }, with_latest_manifest: { type: "boolean", description: "Include the latest prompt manifest (the actual template)." } }; }

  // --- monid ---
  if (toolName === "monid/whoami") { return { workspace_id: { type: "string", description: "Optional workspace id (org_...); only needed for OAuth tokens without workspace context." } }; }
  if (toolName === "monid/list_workspaces") { return { workspace_id: { type: "string", description: "Optional workspace id." } }; }
  if (toolName === "monid/discover") { return { query: { type: "string", description: "Natural-language search for data endpoints, e.g. 'twitter posts'." }, limit: { type: "number", description: "Max results." }, workspace_id: { type: "string", description: "Optional workspace id." } }; }
  if (toolName === "monid/inspect") { return { provider: { type: "string", description: "Provider slug, e.g. apify." }, endpoint: { type: "string", description: "Endpoint id, e.g. /apidojo/tweet-scraper." }, workspace_id: { type: "string", description: "Optional workspace id." } }; }
  if (toolName === "monid/run") { return { provider: { type: "string", description: "Provider slug, e.g. apify." }, endpoint: { type: "string", description: "Endpoint id, e.g. /apidojo/tweet-scraper." }, input: { type: "object", description: "Endpoint input parameters, e.g. { searchTerms: ['AI'], maxItems: 10 }." }, workspace_id: { type: "string", description: "Optional workspace id." } }; }
  if (toolName === "monid/list_runs") { return { limit: { type: "number", description: "Max runs." }, status: { type: "string", description: "Optional status filter." }, cursor: { type: "string", description: "Pagination cursor from a previous page." }, workspace_id: { type: "string", description: "Optional workspace id." } }; }
  if (toolName === "monid/get_run") { return { run_id: { type: "string", description: "Run id." }, workspace_id: { type: "string", description: "Optional workspace id." } }; }
  if (toolName === "monid/stop_run") { return { run_id: { type: "string", description: "Run id." }, workspace_id: { type: "string", description: "Optional workspace id." } }; }
  if (toolName === "monid/get_balance") { return { workspace_id: { type: "string", description: "Optional workspace id." } }; }
  if (toolName === "monid/list_activities") { return { limit: { type: "number", description: "Max activities." }, cursor: { type: "string", description: "Pagination cursor from a previous page." }, workspace_id: { type: "string", description: "Optional workspace id." } }; }

  // --- youcanbookme ---
  if (toolName === "youcanbookme/get_account") { return { account_id: { type: "string", description: "Account id (uuid); recommended for Google/SSO logins where /v1/account 404s. Falls back to the connection credential's account_id." } }; }
  if (toolName === "youcanbookme/list_profiles") { return { fields: { type: "string", description: "Optional comma-separated field selector, e.g. 'id,title,subdomain,questions,questions.code'." } }; }
  if (toolName === "youcanbookme/get_profile") { return { profile_id: { type: "string", description: "Booking page (profile) id (uuid)." }, fields: { type: "string", description: "Optional comma-separated field selector." } }; }
  if (toolName === "youcanbookme/query_bookings") { return { from: { type: "string", description: "Start of time range, ISO 8601 (e.g. 2026-08-01T00:00:00Z). Required." }, to: { type: "string", description: "End of time range, ISO 8601." }, statuses: { type: "array", items: { type: "string" }, description: "Booking statuses: tentative, rejected, cancelled, upcoming, inProgress, finished, noShow." }, booking_page_ids: { type: "array", items: { type: "string" }, description: "Restrict to these booking page (profile) ids." }, search_text: { type: "string", description: "Text search (min 3 chars) against title/form/ref." }, search_text_criteria: { type: "array", items: { type: "string" }, description: "Fields for search_text: title, form, ref (default all)." }, page_size: { type: "number", description: "Bookings per page (10-500, default 50)." }, direction: { type: "string", description: "Pagination direction: forwards (default) or backwards." }, from_booking_id: { type: "string", description: "Starting booking id for pagination." }, account_id: { type: "string", description: "Account id; auto-resolved from /v1/account when omitted." } }; }
  if (toolName === "youcanbookme/get_booking") { return { booking_id: { type: "string", description: "Booking id (uuid)." }, fields: { type: "string", description: "Optional comma-separated field selector, e.g. 'startsAt,endsAt,answers,answers.code,answers.string'." } }; }
  if (toolName === "youcanbookme/update_booking") { return { booking_id: { type: "string", description: "Booking id (uuid)." }, data: { type: "object", description: "Booking fields to PATCH, e.g. { startsAt: '2026-08-10T09:00:00Z' }." } }; }
  if (toolName === "youcanbookme/cancel_booking") { return { booking_id: { type: "string", description: "Booking id (uuid)." }, reason: { type: "string", description: "Optional cancellation reason." } }; }

  // --- calendly ---
  if (toolName === "calendly/get_me") { return {}; }
  if (toolName === "calendly/list_event_types") { return { user: { type: "string", description: "User URI (https://api.calendly.com/users/...). Defaults to the token's user." }, organization: { type: "string", description: "Organization URI for org-wide listing." }, active: { type: "boolean", description: "Filter by active state." }, count: { type: "number", description: "Page size (max 100)." }, page_token: { type: "string", description: "Pagination token from a previous page." } }; }
  if (toolName === "calendly/list_events") { return { user: { type: "string", description: "User URI. Defaults to the token's user." }, organization: { type: "string", description: "Organization URI for org-wide listing." }, min_start_time: { type: "string", description: "ISO 8601 lower bound for event start time." }, max_start_time: { type: "string", description: "ISO 8601 upper bound for event start time." }, status: { type: "string", description: "active or canceled." }, invitee_email: { type: "string", description: "Filter by invitee email." }, sort: { type: "string", description: "e.g. start_time:asc." }, count: { type: "number", description: "Page size (max 100)." }, page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "calendly/get_event") { return { event_uuid: { type: "string", description: "Scheduled event uuid (or full event URI)." } }; }
  if (toolName === "calendly/list_invitees") { return { event_uuid: { type: "string", description: "Scheduled event uuid (or full event URI)." }, status: { type: "string", description: "active or canceled." }, email: { type: "string", description: "Filter by invitee email." }, count: { type: "number", description: "Page size (max 100)." }, page_token: { type: "string", description: "Pagination token." } }; }
  if (toolName === "calendly/cancel_event") { return { event_uuid: { type: "string", description: "Scheduled event uuid (or full event URI)." }, reason: { type: "string", description: "Optional cancellation reason shown to invitees." } }; }

  // --- calcom ---
  if (toolName === "calcom/get_me") { return {}; }
  if (toolName === "calcom/list_event_types") { return { username: { type: "string", description: "Filter by username; defaults to the API key's user." }, event_slug: { type: "string", description: "Filter by event type slug." } }; }
  if (toolName === "calcom/list_schedules") { return {}; }
  if (toolName === "calcom/list_bookings") { return { status: { type: "string", description: "upcoming, recurring, past, cancelled, or unconfirmed." }, attendee_email: { type: "string", description: "Filter by attendee email." }, attendee_name: { type: "string", description: "Filter by attendee name." }, after_start: { type: "string", description: "ISO 8601 lower bound for booking start." }, before_end: { type: "string", description: "ISO 8601 upper bound for booking end." }, event_type_id: { type: "string", description: "Filter by event type id." }, sort_start: { type: "string", description: "asc or desc by start time." }, take: { type: "number", description: "Page size." }, skip: { type: "number", description: "Offset for pagination." } }; }
  if (toolName === "calcom/get_booking") { return { booking_uid: { type: "string", description: "Booking uid." } }; }
  if (toolName === "calcom/cancel_booking") { return { booking_uid: { type: "string", description: "Booking uid." }, reason: { type: "string", description: "Optional cancellation reason." } }; }

  // --- acuity ---
  if (toolName === "acuity/get_me") { return {}; }
  if (toolName === "acuity/list_calendars") { return {}; }
  if (toolName === "acuity/list_appointment_types") { return { include_deleted: { type: "boolean", description: "Include deleted appointment types." } }; }
  if (toolName === "acuity/list_appointments") { return { min_date: { type: "string", description: "Only appointments on/after this date (YYYY-MM-DD)." }, max_date: { type: "string", description: "Only appointments on/before this date (YYYY-MM-DD)." }, calendar_id: { type: "string", description: "Filter by calendar id." }, appointment_type_id: { type: "string", description: "Filter by appointment type id." }, email: { type: "string", description: "Filter by client email." }, first_name: { type: "string", description: "Filter by client first name." }, last_name: { type: "string", description: "Filter by client last name." }, canceled: { type: "boolean", description: "Return canceled appointments instead of active ones." }, max: { type: "number", description: "Max results (default 100)." }, direction: { type: "string", description: "Sort by date: ASC or DESC." } }; }
  if (toolName === "acuity/get_appointment") { return { appointment_id: { type: "string", description: "Appointment id." } }; }
  if (toolName === "acuity/list_availability_times") { return { date: { type: "string", description: "Date to check (YYYY-MM-DD)." }, appointment_type_id: { type: "string", description: "Appointment type id." }, calendar_id: { type: "string", description: "Optional calendar id." }, timezone: { type: "string", description: "Optional IANA timezone, e.g. Asia/Tokyo." } }; }
  if (toolName === "acuity/cancel_appointment") { return { appointment_id: { type: "string", description: "Appointment id." }, reason: { type: "string", description: "Optional cancellation note." }, no_email: { type: "boolean", description: "Suppress cancellation emails." } }; }

  // --- timerex ---
  if (toolName === "timerex/get_primary_team") { return {}; }
  if (toolName === "timerex/list_teams") { return {}; }
  if (toolName === "timerex/get_team") { return { team_id: { type: "string", description: "Team id (API key's team only)." } }; }
  if (toolName === "timerex/list_calendars") { return { team_id: { type: "string", description: "Team id." }, sort_order: { type: "string", description: "Optional sort order." } }; }
  if (toolName === "timerex/get_calendar") { return { calendar_id: { type: "string", description: "Scheduling calendar id." } }; }
  if (toolName === "timerex/list_calendar_events") { return { calendar_id: { type: "string", description: "Scheduling calendar id." }, start_time: { type: "string", description: "ISO 8601 lower bound for event start." }, end_time: { type: "string", description: "ISO 8601 upper bound for event start." } }; }
  if (toolName === "timerex/get_event") { return { event_id: { type: "string", description: "Confirmed event id." } }; }
  if (toolName === "timerex/cancel_event") { return { event_id: { type: "string", description: "Confirmed event id." }, data: { type: "object", description: "Optional cancellation options (raw request body)." } }; }
  if (toolName === "timerex/create_one_time_url") { return { calendar_id: { type: "string", description: "Scheduling calendar id." }, data: { type: "object", description: "One-time URL options (raw request body)." } }; }
  if (toolName === "timerex/get_one_time_url") { return { one_time_url_id: { type: "string", description: "One-time URL id." } }; }

  // --- dataforseo ---
  // Targeting: pass location_code/language_code (fastest) or location_name/
  // language_name. Endpoints that require targeting default to Japan (2392) / ja.
  if (toolName === "dataforseo/get_user_data") { return {}; }
  if (toolName === "dataforseo/list_locations") { return { country: { type: "string", description: "ISO 3166-1 alpha-2 country code, e.g. JP or US. Defaults to JP." }, query: { type: "string", description: "Case-insensitive substring filter on the location name." }, limit: { type: "number", description: "Max locations to return (default 50, max 200)." } }; }
  if (toolName === "dataforseo/serp_google_organic") { return { keyword: { type: "string", description: "Search query (up to 700 characters)." }, location_code: { type: "number", description: "DataForSEO location code, e.g. 2392 = Japan (default), 2840 = United States." }, location_name: { type: "string", description: "Location name, e.g. \"Japan\" or \"Tokyo,Japan\". Ignored when location_code is set." }, language_code: { type: "string", description: "Language code, e.g. ja (default) or en." }, language_name: { type: "string", description: "Language name, e.g. Japanese. Ignored when language_code is set." }, device: { type: "string", description: "desktop (default) or mobile." }, depth: { type: "number", description: "Number of SERP results to parse (default 20, max 200)." }, os: { type: "string", description: "windows/macos for desktop, android/ios for mobile." } }; }
  if (toolName === "dataforseo/keyword_search_volume") { return { keywords: { type: "array", items: { type: "string" }, description: "Keywords to look up (max 1000; one request is billed regardless of count)." }, location_code: { type: "number", description: "Location code (default 2392 = Japan)." }, location_name: { type: "string", description: "Location name, e.g. Japan." }, language_code: { type: "string", description: "Language code (default ja)." }, language_name: { type: "string", description: "Language name, e.g. Japanese." }, search_partners: { type: "boolean", description: "Include Google search partner networks." }, date_from: { type: "string", description: "Start of the trend window (YYYY-MM-DD). Defaults to the past 12 months." }, date_to: { type: "string", description: "End of the trend window (YYYY-MM-DD)." }, sort_by: { type: "string", description: "relevance, search_volume, competition, low_top_of_page_bid or high_top_of_page_bid." }, include_monthly: { type: "boolean", description: "Include the monthly_searches history per keyword (large). Off by default." } }; }
  if (toolName === "dataforseo/keyword_ideas") { return { keywords: { type: "array", items: { type: "string" }, description: "Seed keywords (max 200)." }, location_code: { type: "number", description: "Location code (default 2392 = Japan)." }, location_name: { type: "string", description: "Location name, e.g. Japan." }, language_code: { type: "string", description: "Language code (default ja)." }, language_name: { type: "string", description: "Language name, e.g. Japanese." }, limit: { type: "number", description: "Max ideas to return (default 100, max 1000)." }, offset: { type: "number", description: "Results to skip for pagination." }, filters: { type: "array", description: "DataForSEO filter expression, e.g. [[\"keyword_info.search_volume\",\">\",100]]." }, order_by: { type: "array", items: { type: "string" }, description: "Sort rules, e.g. [\"keyword_info.search_volume,desc\"]." }, closely_variants: { type: "boolean", description: "Phrase-match (true) instead of broad-match idea generation." } }; }
  if (toolName === "dataforseo/ranked_keywords") { return { target: { type: "string", description: "Domain, subdomain, or page URL to inspect (domains without https:// or www.)." }, location_code: { type: "number", description: "Location code (default 2392 = Japan)." }, location_name: { type: "string", description: "Location name, e.g. Japan." }, language_code: { type: "string", description: "Language code (default ja)." }, language_name: { type: "string", description: "Language name, e.g. Japanese." }, limit: { type: "number", description: "Max keywords (default 100, max 1000)." }, offset: { type: "number", description: "Results to skip for pagination." }, filters: { type: "array", description: "DataForSEO filter expression." }, order_by: { type: "array", items: { type: "string" }, description: "Sort rules, e.g. [\"keyword_data.keyword_info.search_volume,desc\"]." }, item_types: { type: "array", items: { type: "string" }, description: "SERP element types to include: organic, paid, featured_snippet, local_pack." } }; }
  if (toolName === "dataforseo/domain_rank_overview") { return { target: { type: "string", description: "Domain without https:// or www." }, location_code: { type: "number", description: "Location code (default 2392 = Japan)." }, location_name: { type: "string", description: "Location name, e.g. Japan." }, language_code: { type: "string", description: "Language code (default ja)." }, language_name: { type: "string", description: "Language name, e.g. Japanese." }, limit: { type: "number", description: "Max result rows (default 10)." } }; }
  if (toolName === "dataforseo/competitors_domain") { return { target: { type: "string", description: "Domain without https:// or www." }, location_code: { type: "number", description: "Location code (default 2392 = Japan)." }, location_name: { type: "string", description: "Location name, e.g. Japan." }, language_code: { type: "string", description: "Language code (default ja)." }, language_name: { type: "string", description: "Language name, e.g. Japanese." }, limit: { type: "number", description: "Max competitor domains (default 20, max 1000)." }, offset: { type: "number", description: "Results to skip for pagination." }, filters: { type: "array", description: "DataForSEO filter expression." }, order_by: { type: "array", items: { type: "string" }, description: "Sort rules, e.g. [\"metrics.organic.count,desc\"]." }, exclude_top_domains: { type: "boolean", description: "Drop the largest global sites (Wikipedia, Amazon, ...)." }, max_rank_group: { type: "number", description: "Only consider the top N organic positions." } }; }
  if (toolName === "dataforseo/backlinks_summary") { return { target: { type: "string", description: "Domain, subdomain, or absolute page URL." }, internal_list_limit: { type: "number", description: "Max elements per breakdown array (default 10, max 1000)." }, backlinks_status_type: { type: "string", description: "all, live (default), or lost." }, include_subdomains: { type: "boolean", description: "Include subdomains of the target (default true)." } }; }
  if (toolName === "dataforseo/backlinks_list") { return { target: { type: "string", description: "Domain, subdomain, or absolute page URL." }, mode: { type: "string", description: "as_is, one_per_domain (default), or one_per_anchor." }, backlinks_status_type: { type: "string", description: "all, live (default), or lost." }, include_subdomains: { type: "boolean", description: "Include subdomains of the target (default true)." }, limit: { type: "number", description: "Max backlinks (default 100, max 1000)." }, offset: { type: "number", description: "Results to skip for pagination." }, filters: { type: "array", description: "DataForSEO filter expression, e.g. [[\"dofollow\",\"=\",true]]." }, order_by: { type: "array", items: { type: "string" }, description: "Sort rules, e.g. [\"rank,desc\"]." } }; }
  if (toolName === "dataforseo/referring_domains") { return { target: { type: "string", description: "Domain, subdomain, or absolute page URL." }, backlinks_status_type: { type: "string", description: "all, live (default), or lost." }, include_subdomains: { type: "boolean", description: "Include subdomains of the target (default true)." }, limit: { type: "number", description: "Max referring domains (default 100, max 1000)." }, offset: { type: "number", description: "Results to skip for pagination." }, filters: { type: "array", description: "DataForSEO filter expression." }, order_by: { type: "array", items: { type: "string" }, description: "Sort rules, e.g. [\"backlinks,desc\"]." } }; }
  if (toolName === "dataforseo/on_page_instant") { return { url: { type: "string", description: "Absolute URL of the page to analyze." }, enable_javascript: { type: "boolean", description: "Render the page with JavaScript enabled." }, browser_preset: { type: "string", description: "desktop, mobile, or tablet." }, custom_user_agent: { type: "string", description: "User agent to crawl with." } }; }

  // --- jicoo ---
  if (toolName === "jicoo/get_me") { return {}; }
  if (toolName === "jicoo/list_teams") { return {}; }
  if (toolName === "jicoo/list_event_types") { return { team_id: { type: "string", description: "Optional team id filter." }, page: { type: "number", description: "Page number." }, per_page: { type: "number", description: "Items per page." } }; }
  if (toolName === "jicoo/get_event_type") { return { event_type_id: { type: "string", description: "Event type id." } }; }
  if (toolName === "jicoo/list_available_schedules") { return { event_type_id: { type: "string", description: "Event type id." }, started_at: { type: "string", description: "ISO 8601 lower bound (UTC)." }, ended_at: { type: "string", description: "ISO 8601 upper bound (UTC)." }, timezone: { type: "string", description: "IANA timezone, e.g. Asia/Tokyo." } }; }
  if (toolName === "jicoo/list_bookings") { return { status: { type: "string", description: "open or cancel." }, started_at: { type: "string", description: "Only bookings starting on/after this ISO 8601 time (UTC)." }, ended_at: { type: "string", description: "Only bookings ending on/before this ISO 8601 time (UTC)." }, sort: { type: "string", description: "asc or desc." }, order: { type: "string", description: "startedAt or createdAt." }, page: { type: "number", description: "Page number." }, per_page: { type: "number", description: "Items per page." } }; }
  if (toolName === "jicoo/get_booking") { return { booking_id: { type: "string", description: "Booking id." } }; }
  if (toolName === "jicoo/update_booking") { return { booking_id: { type: "string", description: "Booking id." }, data: { type: "object", description: "Booking fields to PATCH (name, description, timezone, start/end, hosts, ...)." } }; }
  if (toolName === "jicoo/cancel_booking") { return { booking_id: { type: "string", description: "Booking id." }, reason: { type: "string", description: "Optional cancellation reason." } }; }

  // --- firecrawl ---
  if (toolName === "firecrawl/scrape") { return { url: { type: "string", description: "URL to scrape." }, formats: { type: "array", description: "Output formats, e.g. [\"markdown\",\"html\",\"links\",\"screenshot\"]. Defaults to markdown.", items: { type: "string" } }, options: { type: "object", description: "Extra Firecrawl scrape options merged into the request body (onlyMainContent, includeTags, excludeTags, waitFor, actions, jsonOptions, ...)." } }; }
  if (toolName === "firecrawl/crawl") { return { url: { type: "string", description: "Root URL to crawl." }, limit: { type: "number", description: "Max pages to crawl." }, options: { type: "object", description: "Extra crawl options merged into the body (includePaths, excludePaths, maxDepth, scrapeOptions, ...). Returns a crawl id; poll firecrawl/get_crawl_status." } }; }
  if (toolName === "firecrawl/get_crawl_status") { return { crawl_id: { type: "string", description: "Crawl id returned by firecrawl/crawl." } }; }
  if (toolName === "firecrawl/cancel_crawl") { return { crawl_id: { type: "string", description: "Crawl id to cancel." } }; }
  if (toolName === "firecrawl/map") { return { url: { type: "string", description: "URL to map (discover all links on the site)." }, options: { type: "object", description: "Extra map options merged into the body (search, limit, sitemapOnly, includeSubdomains, ...)." } }; }
  if (toolName === "firecrawl/search") { return { query: { type: "string", description: "Search query." }, limit: { type: "number", description: "Max results." }, options: { type: "object", description: "Extra search options merged into the body (sources, tbs, location, scrapeOptions, ...)." } }; }
  if (toolName === "firecrawl/extract") { return { urls: { type: "array", description: "URLs (or wildcard patterns like https://example.com/*) to extract structured data from.", items: { type: "string" } }, prompt: { type: "string", description: "Natural-language extraction instruction." }, schema: { type: "object", description: "Optional JSON schema describing the shape of the data to extract." }, options: { type: "object", description: "Extra extract options merged into the body. Returns an extract id; poll firecrawl/get_extract_status." } }; }
  if (toolName === "firecrawl/get_extract_status") { return { extract_id: { type: "string", description: "Extract id returned by firecrawl/extract." } }; }
  if (toolName === "firecrawl/get_credit_usage") { return {}; }
  // --- google_tag_manager ---
  if (toolName === "google_tag_manager/list_containers") { return { account_id: { type: "string", description: "GTM account id." } }; }
  if (toolName === "google_tag_manager/get_container") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." } }; }
  if (toolName === "google_tag_manager/list_workspaces") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." } }; }
  if (toolName === "google_tag_manager/list_tags") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." }, workspace_id: { type: "string", description: "GTM workspace id." } }; }
  if (toolName === "google_tag_manager/create_tag") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." }, workspace_id: { type: "string", description: "GTM workspace id." }, tag: { type: "object", description: "Raw GTM Tag resource, e.g. a GA4 config tag: {\"name\":\"GA4 Config\",\"type\":\"googtag\",\"parameter\":[{\"type\":\"template\",\"key\":\"tagId\",\"value\":\"G-XXXX\"}],\"firingTriggerId\":[\"2147479553\"]}. 2147479553 is the built-in All Pages trigger." } }; }
  if (toolName === "google_tag_manager/create_version") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." }, workspace_id: { type: "string", description: "GTM workspace id." }, name: { type: "string", description: "Optional version name." }, notes: { type: "string", description: "Optional version notes." } }; }
  if (toolName === "google_tag_manager/publish_version") { return { account_id: { type: "string", description: "GTM account id." }, container_id: { type: "string", description: "GTM container id." }, version_id: { type: "string", description: "GTM container version id (from create_version's containerVersion.containerVersionId)." }, fingerprint: { type: "string", description: "Optional version fingerprint guard." } }; }
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
  const metaToolName = metaAdsRuntimeToolName(toolName);
  if (SYSTEM_TOOLS.includes(toolName as any)) return [];
  if (isAdminTool(toolName)) return adminToolDescriptor(toolName).required;
  if (toolName === "github/get_file_contents") return ["owner", "repo"];
  if (toolName === "github/get_repo") return ["owner", "repo"];
  if (toolName === "github/list_issues") return ["owner", "repo"];
  if (toolName === "github/create_issue") return ["owner", "repo", "title"];
  if (toolName === "github/git_push_repo") return ["owner", "repo", "files"];
  if (toolName === "github/create_pull_request") return ["owner", "repo", "title", "head"];
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
  if (toolName === "godaddy/get_domain") return ["domain"];
  if (toolName === "godaddy/check_availability") return ["domain"];
  if (toolName === "godaddy/list_dns_records") return ["domain"];
  if (toolName === "godaddy/add_dns_records") return ["domain"];
  if (toolName === "godaddy/replace_dns_records") return ["domain", "type", "name"];
  if (toolName === "godaddy/delete_dns_record") return ["domain", "type", "name"];
  if (toolName === "google_drive/get_file") return ["file_id"];
  if (toolName === "google_gsc/search_analytics") return ["site_url", "start_date", "end_date"];
  if (toolName === "google_analytics/run_report") return ["property_id", "start_date", "end_date"];
  if (toolName === "google_analytics/create_property") return ["account_id", "display_name"];
  if (toolName === "google_analytics/create_data_stream") return ["property_id", "default_uri"];
  if (toolName === "google_analytics/list_data_streams") return ["property_id"];
  if (toolName === "google_ads/search") return ["customer_id", "query"];
  if (toolName === "google_ads/mutate") return ["customer_id", "operations"];
  if (toolName === "yahoo_ads/get") return ["base_account_id", "service"];
  if (toolName === "yahoo_ads/mutate") return ["base_account_id", "service", "method"];
  if (metaToolName === "meta_ads/get_ad_account") return ["account_id"];
  if (metaToolName === "meta_ads/list_campaigns") return ["account_id"];
  if (metaToolName === "meta_ads/get_campaign") return ["campaign_id"];
  if (metaToolName === "meta_ads/create_campaign") return ["account_id", "campaign"];
  if (metaToolName === "meta_ads/update_campaign") return ["campaign_id", "updates"];
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
  if (toolName === "youtube/create_upload_session") return ["title"];
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
  if (toolName === "apollo/enrich_organization") return ["domain"];
  if (toolName === "apollo/update_contact") return ["contact_id"];
  if (toolName === "apollo/add_contacts_to_sequence") return ["sequence_id"];
  if (toolName === "heyreach/get_campaign") return ["campaign_id"];
  if (toolName === "heyreach/pause_campaign") return ["campaign_id"];
  if (toolName === "heyreach/resume_campaign") return ["campaign_id"];
  if (toolName === "heyreach/add_leads_to_campaign") return [];
  if (toolName === "heyreach/create_empty_list") return [];
  if (toolName === "smartlead/get_campaign") return ["campaign_id"];
  if (toolName === "smartlead/get_campaign_analytics") return ["campaign_id"];
  if (toolName === "smartlead/get_campaign_statistics") return ["campaign_id"];
  if (toolName === "smartlead/update_campaign_status") return ["campaign_id"];
  if (toolName === "smartlead/save_sequence") return ["campaign_id"];
  if (toolName === "smartlead/add_leads_to_campaign") return ["campaign_id"];
  if (toolName === "smartlead/list_campaign_leads") return ["campaign_id"];
  if (toolName === "smartlead/get_message_history") return ["campaign_id", "lead_id"];
  if (toolName === "smartlead/create_campaign") return [];
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
  if (toolName === "channel_talk/get_manager") return ["manager_id"];
  if (toolName === "channel_talk/get_user_chat") return ["user_chat_id"];
  if (toolName === "channel_talk/list_messages") return ["user_chat_id"];
  if (toolName === "channel_talk/send_message") return ["user_chat_id"];
  if (toolName === "channel_talk/get_user") return ["user_id"];
  if (toolName === "channel_talk_documents/list_articles") return ["language"];
  if (toolName === "channel_talk_documents/get_article") return ["article_id", "language"];
  if (toolName === "channel_talk_documents/delete_article") return ["article_id"];
  if (toolName === "channel_talk_documents/get_topic") return ["topic_id"];
  if (toolName === "railway/graphql") return ["query"];
  if (toolName === "google_maps/geocode") return ["address"];
  if (toolName === "google_maps/reverse_geocode") return [];
  if (toolName === "google_maps/place_search") return ["query"];
  if (toolName === "google_maps/place_details") return ["place_id"];
  if (toolName === "google_maps/directions") return ["origin", "destination"];
  if (toolName === "google_maps/distance_matrix") return ["origins", "destinations"];
  if (toolName === "resend/send_email") return ["from", "to", "subject"];
  if (toolName === "resend/get_email") return ["email_id"];
  if (toolName === "granola/get_note") return ["note_id"];
  if (toolName === "tldv/list_meetings") return [];
  if (toolName === "tldv/get_meeting") return ["meeting_id"];
  if (toolName === "tldv/get_transcript") return ["meeting_id"];
  if (toolName === "tldv/get_notes") return ["meeting_id"];
  if (toolName === "tldv/get_highlights") return ["meeting_id"];
  if (toolName === "tldv/get_download_url") return ["meeting_id"];
  if (toolName === "tldv/import_meeting") return ["url"];
  if (toolName === "zapmail/get_mailbox") return ["mailbox_id"];
  if (toolName === "zapmail/get_dns_records") return ["domain_id"];
  if (toolName === "zapmail/list_third_party_accounts") return ["app"];
  if (toolName === "zapmail/get_export_status") return ["export_id"];
  if (toolName === "zapmail/export_mailboxes") return ["apps"];
  if (toolName === "zapmail/search_domains") return ["domain_name"];
  if (toolName === "zapmail/check_domains") return ["domain_names"];
  if (toolName === "zapmail/ai_find_domains") return ["keywords"];
  if (toolName === "zapmail/get_name_servers") return ["domain_name"];
  if (toolName === "zapmail/verify_name_servers") return ["domain_name"];
  if (toolName === "zapmail/connect_domain") return ["domain_names"];
  if (toolName === "zapmail/assign_mailboxes") return ["domain_id", "domain_name", "mailboxes"];
  if (toolName === "zapmail/add_dmarc") return ["domain_ids", "email"];
  if (toolName === "zapmail/add_forwarding") return ["domain_ids", "forward_to"];
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
  if (toolName === "x/post_tweet") return [];
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
  if (toolName === "openai/generate_image") return ["prompt"];
  if (toolName === "higgsfield/generate_image") return ["prompt"];
  if (toolName === "higgsfield/get_request") return ["request_id"];
  if (toolName === "higgsfield/cancel_request") return ["request_id"];
  if (toolName === "openai_ads/get_campaign") return ["campaign_id"];
  if (toolName === "openai_ads/get_ad_group") return ["ad_group_id"];
  if (toolName === "openai_ads/get_ad") return ["ad_id"];
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
  if (toolName === "google_slides/get_presentation") return ["presentation_id"];
  if (toolName === "google_slides/get_page") return ["presentation_id", "page_object_id"];
  if (toolName === "google_slides/get_page_thumbnail") return ["presentation_id", "page_object_id"];
  if (toolName === "google_slides/create_presentation") return ["title"];
  if (toolName === "google_slides/batch_update") return ["presentation_id", "requests"];
  if (toolName === "google_forms/get_form") return ["form_id"];
  if (toolName === "google_forms/create_form") return ["title"];
  if (toolName === "google_forms/batch_update") return ["form_id", "requests"];
  if (toolName === "google_forms/list_responses") return ["form_id"];
  if (toolName === "google_forms/get_response") return ["form_id", "response_id"];
  if (toolName === "twenty/list_objects") return [];
  if (toolName === "twenty/list_records") return ["object"];
  if (toolName === "twenty/get_record") return ["object", "record_id"];
  if (toolName === "twenty/create_record") return ["object", "data"];
  if (toolName === "twenty/update_record") return ["object", "record_id", "data"];
  if (toolName === "nocodb/get_me") return [];
  if (toolName === "nocodb/list_bases") return [];
  if (toolName === "nocodb/list_tables") return ["base_id"];
  if (toolName === "nocodb/get_table") return ["table_id"];
  if (toolName === "nocodb/list_views") return ["table_id"];
  if (toolName === "nocodb/list_records") return ["table_id"];
  if (toolName === "nocodb/count_records") return ["table_id"];
  if (toolName === "nocodb/get_record") return ["table_id", "record_id"];
  if (toolName === "nocodb/create_records") return ["table_id"];
  if (toolName === "nocodb/update_records") return ["table_id"];
  if (toolName === "nocodb/delete_records") return ["table_id"];
  if (toolName === "langgraph/get_info") return [];
  if (toolName === "langgraph/search_assistants") return [];
  if (toolName === "langgraph/get_assistant") return ["assistant_id"];
  if (toolName === "langgraph/get_assistant_schemas") return ["assistant_id"];
  if (toolName === "langgraph/search_threads") return [];
  if (toolName === "langgraph/create_thread") return [];
  if (toolName === "langgraph/get_thread") return ["thread_id"];
  if (toolName === "langgraph/get_thread_state") return ["thread_id"];
  if (toolName === "langgraph/get_thread_history") return ["thread_id"];
  if (toolName === "langgraph/list_runs") return ["thread_id"];
  if (toolName === "langgraph/get_run") return ["thread_id", "run_id"];
  if (toolName === "langgraph/create_run") return ["assistant_id"];
  if (toolName === "langgraph/run_wait") return ["assistant_id"];
  if (toolName === "langgraph/cancel_run") return ["thread_id", "run_id"];
  if (toolName === "langgraph/search_crons") return [];
  if (toolName === "langgraph/delete_cron") return ["cron_id"];
  if (toolName === "langgraph/search_store_items") return [];
  if (toolName === "langsmith/list_workspaces") return [];
  if (toolName === "langsmith/list_projects") return [];
  if (toolName === "langsmith/get_project") return ["project_id"];
  if (toolName === "langsmith/query_runs") return [];
  if (toolName === "langsmith/get_run") return ["run_id"];
  if (toolName === "langsmith/list_datasets") return [];
  if (toolName === "langsmith/get_dataset") return ["dataset_id"];
  if (toolName === "langsmith/list_examples") return ["dataset_id"];
  if (toolName === "langsmith/create_examples") return ["dataset_id"];
  if (toolName === "langsmith/list_feedback") return [];
  if (toolName === "langsmith/create_feedback") return ["run_id", "key"];
  if (toolName === "langsmith/list_prompts") return [];
  if (toolName === "langsmith/get_prompt") return ["owner", "repo"];
  if (toolName === "monid/whoami") return [];
  if (toolName === "monid/list_workspaces") return [];
  if (toolName === "monid/discover") return ["query"];
  if (toolName === "monid/inspect") return ["provider", "endpoint"];
  if (toolName === "monid/run") return ["provider", "endpoint"];
  if (toolName === "monid/list_runs") return [];
  if (toolName === "monid/get_run") return ["run_id"];
  if (toolName === "monid/stop_run") return ["run_id"];
  if (toolName === "monid/get_balance") return [];
  if (toolName === "monid/list_activities") return [];
  if (toolName === "youcanbookme/get_account") return [];
  if (toolName === "youcanbookme/list_profiles") return [];
  if (toolName === "youcanbookme/get_profile") return ["profile_id"];
  if (toolName === "youcanbookme/query_bookings") return ["from"];
  if (toolName === "youcanbookme/get_booking") return ["booking_id"];
  if (toolName === "youcanbookme/update_booking") return ["booking_id", "data"];
  if (toolName === "youcanbookme/cancel_booking") return ["booking_id"];
  if (toolName === "calendly/get_me") return [];
  if (toolName === "calendly/list_event_types") return [];
  if (toolName === "calendly/list_events") return [];
  if (toolName === "calendly/get_event") return ["event_uuid"];
  if (toolName === "calendly/list_invitees") return ["event_uuid"];
  if (toolName === "calendly/cancel_event") return ["event_uuid"];
  if (toolName === "calcom/get_me") return [];
  if (toolName === "calcom/list_event_types") return [];
  if (toolName === "calcom/list_schedules") return [];
  if (toolName === "calcom/list_bookings") return [];
  if (toolName === "calcom/get_booking") return ["booking_uid"];
  if (toolName === "calcom/cancel_booking") return ["booking_uid"];
  if (toolName === "acuity/get_me") return [];
  if (toolName === "acuity/list_calendars") return [];
  if (toolName === "acuity/list_appointment_types") return [];
  if (toolName === "acuity/list_appointments") return [];
  if (toolName === "acuity/get_appointment") return ["appointment_id"];
  if (toolName === "acuity/list_availability_times") return ["date", "appointment_type_id"];
  if (toolName === "acuity/cancel_appointment") return ["appointment_id"];
  if (toolName === "timerex/get_primary_team") return [];
  if (toolName === "timerex/list_teams") return [];
  if (toolName === "timerex/get_team") return ["team_id"];
  if (toolName === "timerex/list_calendars") return ["team_id"];
  if (toolName === "timerex/get_calendar") return ["calendar_id"];
  if (toolName === "timerex/list_calendar_events") return ["calendar_id"];
  if (toolName === "timerex/get_event") return ["event_id"];
  if (toolName === "timerex/cancel_event") return ["event_id"];
  if (toolName === "timerex/create_one_time_url") return ["calendar_id"];
  if (toolName === "timerex/get_one_time_url") return ["one_time_url_id"];
  if (toolName === "dataforseo/get_user_data") return [];
  if (toolName === "dataforseo/list_locations") return [];
  if (toolName === "dataforseo/serp_google_organic") return ["keyword"];
  if (toolName === "dataforseo/keyword_search_volume") return ["keywords"];
  if (toolName === "dataforseo/keyword_ideas") return ["keywords"];
  if (toolName === "dataforseo/ranked_keywords") return ["target"];
  if (toolName === "dataforseo/domain_rank_overview") return ["target"];
  if (toolName === "dataforseo/competitors_domain") return ["target"];
  if (toolName === "dataforseo/backlinks_summary") return ["target"];
  if (toolName === "dataforseo/backlinks_list") return ["target"];
  if (toolName === "dataforseo/referring_domains") return ["target"];
  if (toolName === "dataforseo/on_page_instant") return ["url"];
  if (toolName === "jicoo/get_me") return [];
  if (toolName === "jicoo/list_teams") return [];
  if (toolName === "jicoo/list_event_types") return [];
  if (toolName === "jicoo/get_event_type") return ["event_type_id"];
  if (toolName === "jicoo/list_available_schedules") return ["event_type_id"];
  if (toolName === "jicoo/list_bookings") return [];
  if (toolName === "jicoo/get_booking") return ["booking_id"];
  if (toolName === "jicoo/update_booking") return ["booking_id", "data"];
  if (toolName === "jicoo/cancel_booking") return ["booking_id"];
  if (toolName === "firecrawl/scrape") return ["url"];
  if (toolName === "firecrawl/crawl") return ["url"];
  if (toolName === "firecrawl/get_crawl_status") return ["crawl_id"];
  if (toolName === "firecrawl/cancel_crawl") return ["crawl_id"];
  if (toolName === "firecrawl/map") return ["url"];
  if (toolName === "firecrawl/search") return ["query"];
  if (toolName === "firecrawl/extract") return [];
  if (toolName === "firecrawl/get_extract_status") return ["extract_id"];
  if (toolName === "firecrawl/get_credit_usage") return [];
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

// Stored skill-bundle shape (Agent.runbookBundle JSON). content_b64 is the raw
// file bytes base64-encoded, so text and binary assets round-trip identically.
type RunbookBundle = {
  filename: string;
  files: { path: string; size: number; content_b64: string }[];
};

// Extensions we hand back as decoded UTF-8 text; everything else stays base64.
const RUNBOOK_TEXT_EXT = new Set([
  "md", "markdown", "txt", "py", "js", "ts", "json", "csv", "tsv",
  "yaml", "yml", "toml", "sh", "html", "css", "svg", "xml",
]);

function parseRunbookBundle(raw: string | null | undefined): RunbookBundle | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    if (b && Array.isArray(b.files)) return b as RunbookBundle;
  } catch { /* fall through */ }
  return null;
}

// Per-agent runbook: the author-supplied instructions defining what THIS agent
// does (as opposed to grantry/get_skill, the platform manual). Lets an agent be
// shared by its MCP token alone — the recipient calls get_runbook to learn the
// role (and get_runbook_file to pull bundled references/scripts/assets), with no
// repo handoff. Two forms: a single SKILL.md (runbookMarkdown), or a full skill
// bundle (runbookBundle) whose files are listed here and fetched individually.
async function getRunbookContent(agentId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { name: true, description: true, runbookMarkdown: true, runbookBundle: true, updatedAt: true },
  });
  const markdown = agent?.runbookMarkdown ?? "";
  const bundle = parseRunbookBundle(agent?.runbookBundle);
  return {
    // SKILL.md text is always inlined so the caller learns its role in one call.
    markdown,
    // Manifest only (no file bodies) — pull each via grantry_get_runbook_file.
    files: bundle ? bundle.files.map((f) => ({ path: f.path, size: f.size })) : [],
    metadata: {
      format: bundle ? "skill-bundle" : "markdown",
      source: "agent.runbook",
      agent_name: agent?.name ?? null,
      charter: agent?.description ?? null,
      configured: Boolean(markdown) || Boolean(bundle),
      bundle_filename: bundle?.filename ?? null,
      file_count: bundle ? bundle.files.length : 0,
      updated_at: agent?.updatedAt ? agent.updatedAt.toISOString() : null,
      server_version: "0.1.0",
    },
  };
}

// Return one bundled file. Text-like extensions come back decoded; binary assets
// come back base64 (encoding field says which).
async function getRunbookFileContent(agentId: string, path: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { runbookBundle: true },
  });
  const bundle = parseRunbookBundle(agent?.runbookBundle);
  const entry = bundle?.files.find((f) => f.path === path);
  if (!entry) return null;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (RUNBOOK_TEXT_EXT.has(ext)) {
    return { path, encoding: "utf-8", content: Buffer.from(entry.content_b64, "base64").toString("utf8"), size: entry.size };
  }
  return { path, encoding: "base64", content: entry.content_b64, size: entry.size };
}

function providerMetadataItem(p: any, includeTools = true) {
  return {
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
    };
}

async function getProviderMetadata(includeTools = true, workspaceId?: string | null) {
  const providerDefs = workspaceId
    ? await listProvidersForWorkspace(workspaceId)
    : Object.values(PROVIDERS).filter((p) => p.implemented !== false);
  const providers = providerDefs.map((p) => providerMetadataItem(p, includeTools));
  return {
    providers,
    metadata: {
      count: providers.length,
      tool_count_including_system: 1 + SYSTEM_TOOLS.length + providerDefs.reduce((sum, p) => p.implemented === false ? sum : sum + p.tools.length, 0),
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
// Parse a connection's stored connectionConfig JSON into a flat {var: value}
// map for template expansion. Non-secret only; values are coerced to strings
// and blanks dropped. Returns undefined when there is nothing to substitute.
function parseConnectionConfig(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw || raw === "{}") return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === null || value === undefined) continue;
      const str = String(value).trim();
      if (str) out[key] = str;
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

async function dispatchProviderTool(
  provider: string,
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  conn: { provider?: string; encryptedServerCredential: string | null; workspaceId?: string | null; connectionConfig?: string | null },
  // Identifies whose staged uploads a `files` argument may reach. Null for the
  // paths that have no calling agent; those simply cannot attach files.
  agentId: string | null = null,
): Promise<any> {
  const connectionConfig = parseConnectionConfig(conn.connectionConfig);
  if (toolName === `${provider}/request`) {
    const providerDef = await getProviderForWorkspace(provider, conn.workspaceId);
    if (!providerDef) throw new Error(`provider not implemented: ${provider}`);
    return callGenericProviderRequest({
      provider: providerDef,
      toolName,
      requestArgs: args,
      credential: token,
      serverCredential: conn.encryptedServerCredential ? decrypt(conn.encryptedServerCredential) : null,
      config: connectionConfig,
      agentId,
    });
  }
  if (toolName === `${provider}/check_connection`) {
    const providerDef = await getProviderForWorkspace(provider, conn.workspaceId);
    if (!providerDef) throw new Error(`provider not implemented: ${provider}`);
    return callGenericCheckConnection({ provider: providerDef, credential: token, config: connectionConfig });
  }
  if (toolName === `${provider}/list_capabilities`) {
    const providerDef = await getProviderForWorkspace(provider, conn.workspaceId);
    if (!providerDef) throw new Error(`provider not implemented: ${provider}`);
    return callGenericListCapabilities({ provider: providerDef });
  }
  if (provider === "grantry") return callGrantryAdminTool(toolName, args, token);
  if (provider === "notion") return callNotionTool(toolName, args, token);
  if (provider === "github") return callGitHubTool(toolName, args, token);
  if (provider === "cloudflare") return callCloudflareTool(toolName, args, token);
  if (provider === "godaddy") return callGodaddyTool(toolName, args, token);
  if (provider === "clarity") return callClarityTool(toolName, args, token);
  if (provider === "google_drive") return callGoogleDriveTool(toolName, args, token);
  if (provider === "google_gsc") return callGoogleGscTool(toolName, args, token);
  if (provider === "google_analytics") return callGoogleAnalyticsTool(toolName, args, token);
  if (provider === "google_ads") return callGoogleAdsTool(toolName, args, token, conn.encryptedServerCredential ? decrypt(conn.encryptedServerCredential) : null);
  if (provider === "yahoo_ads") return callYahooAdsTool(toolName, args, token);
  if (provider === "meta_ads" || provider === "meta_ads_platform") return callMetaAdsTool(metaAdsRuntimeToolName(toolName), args, token);
  if (provider === "hubspot") return callHubSpotTool(toolName, args, token);
  if (provider === "gmail") return callGmailTool(toolName, args, token);
  if (provider === "youtube") return callYouTubeTool(toolName, args, token);
  if (provider === "attio") return callAttioTool(toolName, args, token);
  if (provider === "twenty") return callTwentyTool(toolName, args, token);
  if (provider === "nocodb") return callNocodbTool(toolName, args, token);
  if (provider === "seminar_portal") return callSeminarPortalTool(toolName, args, token);
  if (provider === "intent_engine") return callIntentEngineTool(toolName, args, token);
  if (provider === "langgraph") return callLanggraphTool(toolName, args, token);
  if (provider === "langsmith") return callLangsmithTool(toolName, args, token);
  if (provider === "monid") return callMonidTool(toolName, args, token);
  if (provider === "youcanbookme") return callYouCanBookMeTool(toolName, args, token);
  if (provider === "calendly") return callCalendlyTool(toolName, args, token);
  if (provider === "calcom") return callCalcomTool(toolName, args, token);
  if (provider === "acuity") return callAcuityTool(toolName, args, token);
  if (provider === "timerex") return callTimerexTool(toolName, args, token);
  if (provider === "jicoo") return callJicooTool(toolName, args, token);
  if (provider === "firecrawl") return callFirecrawlTool(toolName, args, token);
  if (provider === "dataforseo") return callDataForSeoTool(toolName, args, token);
  if (provider === "clay") return callClayTool(toolName, args, token);
  if (provider === "apollo") return callApolloTool(toolName, args, token);
  if (provider === "heyreach") return callHeyReachTool(toolName, args, token);
  if (provider === "smartlead") return callSmartleadTool(toolName, args, token);
  if (provider === "chatwork") return callChatworkTool(toolName, args, token);
  if (provider === "channel_talk") return callChannelTalkTool(toolName, args, token);
  if (provider === "channel_talk_documents") return callChannelTalkDocumentsTool(toolName, args, token);
  if (provider === "railway") {
    const railwayToken = conn.provider === "railway_api" && !token.trim().startsWith("{")
      ? JSON.stringify({ token, token_type: "workspace" })
      : token;
    return callRailwayTool(toolName, args, railwayToken);
  }
  if (provider === "google_maps") return callGoogleMapsTool(toolName, args, token);
  if (provider === "resend") return callResendTool(toolName, args, token);
  if (provider === "granola") return callGranolaTool(toolName, args, token);
  if (provider === "tldv") return callTldvTool(toolName, args, token);
  if (provider === "zapmail") return callZapmailTool(toolName, args, token);
  if (provider === "cloudsign") return callCloudSignTool(toolName, args, token);
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
  if (provider === "openai") return callOpenAITool(toolName, args, token);
  if (provider === "openai_ads") return callOpenAIAdsTool(toolName, args, token);
  if (provider === "higgsfield") return callHiggsfieldTool(toolName, args, token);
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
  if (provider === "google_slides") return callGoogleSlidesTool(toolName, args, token);
  if (provider === "google_forms") return callGoogleFormsTool(toolName, args, token);
  if (provider === "google_tag_manager") return callGoogleTagManagerTool(toolName, args, token);
  if (provider === "google_cloud") return callGoogleCloudTool(toolName, args, token);
  if (provider === "bigquery") return callBigQueryTool(toolName, args, token);
  if (provider === "google_admin") return callGoogleAdminTool(toolName, args, token);
  throw new Error(`no dispatcher for provider: ${provider}`);
}

type SystemToolContext = { agentId?: string; ownerId?: string; workspaceId?: string | null; workspaceSlug?: string; userId?: string };

async function callSystemTool(toolName: string, args: Record<string, unknown>, ctx?: SystemToolContext) {
  if (toolName === "grantry/get_skill") {
    const skill = await getSkillContent();
    return {
      content: [{ type: "text", text: skill.markdown }],
      structuredContent: skill,
      isError: false,
    };
  }
  if (toolName === "grantry/get_runbook") {
    if (!ctx?.agentId) {
      return {
        content: [{ type: "text", text: "get_runbook requires an authenticated agent token." }],
        isError: true,
      };
    }
    const runbook = await getRunbookContent(ctx.agentId);
    let text = runbook.markdown ||
      "This agent has no runbook configured yet. The owner can add one in the grantry dashboard (agent detail → Runbook).";
    if (runbook.files.length) {
      const list = runbook.files.map((f) => `  - ${f.path} (${f.size} bytes)`).join("\n");
      text += `\n\n---\nBundled skill files — fetch each with grantry_get_runbook_file(path), then reconstruct the skill directory:\n${list}`;
    }
    return {
      content: [{ type: "text", text }],
      structuredContent: runbook,
      isError: false,
    };
  }
  if (toolName === "grantry/get_runbook_file") {
    if (!ctx?.agentId) {
      return {
        content: [{ type: "text", text: "get_runbook_file requires an authenticated agent token." }],
        isError: true,
      };
    }
    const path = String(args.path ?? "").trim();
    if (!path) {
      return { content: [{ type: "text", text: "get_runbook_file requires a 'path' from grantry_get_runbook's file list." }], isError: true };
    }
    const file = await getRunbookFileContent(ctx.agentId, path);
    if (!file) {
      return { content: [{ type: "text", text: `No bundled runbook file at path: ${path}` }], isError: true };
    }
    return {
      content: [{ type: "text", text: file.encoding === "utf-8" ? file.content : `<${file.size} bytes, base64 in structuredContent.content>` }],
      structuredContent: file,
      isError: false,
    };
  }
  if (toolName === "grantry/get_providers") {
    const includeTools = args.include_tools !== false && args.includeTools !== false;
    const providers = await getProviderMetadata(includeTools, ctx?.workspaceId);
    // When called with an agent token, surface the scopes this token can
    // actually reach so the caller can discover them in the same round-trip
    // (full detail is in grantry/list_scopes). Anonymous callers get no scopes.
    if (ctx?.agentId) {
      const conns = await connectionsForAgent(ctx.agentId);
      (providers.metadata as Record<string, unknown>).scopes = Array.from(new Set(conns.map((c) => c.scope))).sort();
    }
    return {
      content: [{ type: "text", text: JSON.stringify(providers, null, 2) }],
      structuredContent: providers,
      isError: false,
    };
  }
  if (toolName === "grantry/list_user_agents") {
    if (!ctx?.userId) throw new Error("list_user_agents requires user authentication");
    const agents = await selectableAgentsForUser(ctx.userId, ctx.workspaceSlug);
    const payload = {
      agents: agents.map((agent) => ({
        agent_id: agent.id,
        name: agent.name,
        description: agent.description,
        workspace: agent.workspace,
      })),
      count: agents.length,
      usage: "Call provider tools with agent_id set to one of these agent_id values. If only one agent is listed, grantry can select it automatically.",
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: false };
  }
  if (toolName === "grantry/create_upload_url") {
    if (!ctx?.agentId) throw new Error("create_upload_url requires an authenticated or selected agent");
    const payload = await createUploadTicket(ctx.agentId, {
      ttlSeconds: (args as any)?.ttl_seconds ?? (args as any)?.ttlSeconds,
      maxUses: (args as any)?.max_uses ?? (args as any)?.maxUses,
    });
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError: false };
  }
  if (toolName === "grantry/list_scopes") {
    if (!ctx?.agentId) throw new Error("list_scopes requires an authenticated or selected agent");
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
    if (!ctx?.agentId || !ctx.ownerId) throw new Error("find_agent requires an authenticated or selected agent");
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
    if (!ctx?.ownerId) throw new Error("route requires authentication");
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
const TOKEN_LIKE = /^(gh[pousr]_|github_pat_|ntn_|secret_|re_|sk-|ya29\.|Bearer\s|gn_(agt|adm|grant)_)/;

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
  options: {
    userMode?: boolean;
    requireAgentId?: boolean;
    agentOptionsByTool?: Map<string, { id: string; name: string }[]>;
  } = {},
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
  if (options.userMode) {
    tools.push({
      name: publicToolName("grantry/list_user_agents"),
      description: "grantry: list the agents this authenticated user may act through. On /mcp/u, pass one of the returned agent_id values when calling provider tools.",
      inputSchema: {
        type: "object",
        properties: toolSpecificInputProperties("grantry/list_user_agents"),
        required: [],
      },
    });
  }
  if (!connections) return tools;

  if (!options.userMode) {
    // Capability discovery tools search the calling agent's workspace.
    tools.push(
      {
        name: publicToolName("grantry/get_runbook"),
        description: "grantry: this agent's own runbook — the author-supplied instructions defining what this agent does and how. Call this first when you connect to learn your role. Returns the SKILL.md text inline; if a skill bundle is attached, also lists its files (fetch each with grantry_get_runbook_file). Distinct from grantry_get_skill, which is the grantry platform manual.",
        inputSchema: {
          type: "object",
          properties: toolSpecificInputProperties("grantry/get_runbook"),
          required: [],
        },
      },
      {
        name: publicToolName("grantry/get_runbook_file"),
        description: "grantry: fetch one file from this agent's skill bundle (references/scripts/assets) by the path shown in grantry_get_runbook. Text files come back decoded; binary assets come back base64. Reconstruct the skill directory from these to run the bundled skill.",
        inputSchema: {
          type: "object",
          properties: toolSpecificInputProperties("grantry/get_runbook_file"),
          required: ["path"],
        },
      },
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
      {
        name: publicToolName("grantry/create_upload_url"),
        description: "grantry: mint a short-lived upload URL for sending a file to a provider that needs multipart or a downloadable URL. POST the file to it with curl (-F file=@path), then pass the returned file_id as `files: [{ field, file_id }]` on <provider>/request. Keeps file bytes out of the conversation.",
        inputSchema: {
          type: "object",
          properties: toolSpecificInputProperties("grantry/create_upload_url"),
          required: [],
        },
      },
    );
  }

  const scopesByTool = new Map<string, Set<string>>();
  const authTypesByTool = new Map<string, Set<string>>();
  const connectionIdsByTool = new Map<string, Set<string>>();
  const providerLabelsByTool = new Map<string, Set<string>>();
  for (const conn of connections) {
    for (const tool of conn.tools) {
      if (!scopesByTool.has(tool)) scopesByTool.set(tool, new Set());
      if (!authTypesByTool.has(tool)) authTypesByTool.set(tool, new Set());
      if (!connectionIdsByTool.has(tool)) connectionIdsByTool.set(tool, new Set());
      if (!providerLabelsByTool.has(tool)) providerLabelsByTool.set(tool, new Set());
      scopesByTool.get(tool)!.add(conn.scope);
      authTypesByTool.get(tool)!.add(conn.authType);
      connectionIdsByTool.get(tool)!.add(conn.id);
      providerLabelsByTool.get(tool)!.add(PROVIDERS[conn.provider]?.label ?? conn.provider);
    }
  }

  const advertisedToolNames = new Set<string>();
  const toolNamesToAdvertise = Array.from(new Set([
    ...scopesByTool.keys(),
    ...delegatable.keys(),
  ])).sort();
  for (const toolName of toolNamesToAdvertise) {
      if (advertisedToolNames.has(toolName)) continue;
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
      const providerKey = toolName.split("/", 1)[0] ?? "";
      const providerLabel = Array.from(providerLabelsByTool.get(toolName) ?? [PROVIDERS[providerKey]?.label ?? providerKey]).sort().join(" / ");
      // Flag tools that are *only* reachable by delegation, so the model knows a
      // grant_token is required rather than a direct call.
      const delegationOnly = directScopes.size === 0;
      const description = delegationOnly
        ? `${providerLabel}: ${action} (delegated — mint a grant_token via grantry_delegate, then call with that grant_token + scope)`
        : `${providerLabel}: ${action}`;
      advertisedToolNames.add(toolName);
      tools.push({
        name: publicToolName(toolName),
        description,
        inputSchema: {
          type: "object",
          properties: {
            ...(options.userMode ? {
              agent_id: {
                type: "string",
                enum: Array.from(new Set((options.agentOptionsByTool?.get(toolName) ?? []).map((a) => a.id))).sort(),
                description: "Agent to act through for this call. Use grantry_list_user_agents to inspect names and descriptions.",
              },
            } : {}),
            scope: { type: "string", enum: scopes, description: "Tenant scope. Use one of the scopes exposed for this agent token." },
            auth_type: { type: "string", enum: authTypes, description: "Optional auth type disambiguator." },
            connection_id: { type: "string", enum: connectionIds, description: "Optional connection id disambiguator." },
            grant_token: { type: "string", description: "One-time delegation grant from grantry_delegate, authorizing this exact tool+scope via a capable peer agent. Required for delegated scopes (those without a direct connection on this agent token)." },
            ...toolSpecificInputProperties(toolName),
          },
          required: [...(options.userMode && options.requireAgentId ? ["agent_id"] : []), "scope", ...requiredToolSpecificArgs(toolName)],
        },
      });
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
type ResolvedAgent = { id: string; name: string; enabled: boolean; userId?: string | null };
type ResolvedMcpUser = { userId: string; clientId?: string; tokenId?: string };

async function resolveAgent(authHeader: string | null): Promise<ResolvedAgent | null> {
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
async function resolveOAuthAccessToken(token: string): Promise<{ userId: string; clientId: string } | null> {
  const accessToken = await prisma.oauthAccessToken
    .findUnique({ where: { accessToken: token } })
    .catch(() => null);
  if (!accessToken || !accessToken.userId) return null;
  if (accessToken.accessTokenExpiresAt && accessToken.accessTokenExpiresAt < new Date()) return null;
  return { userId: accessToken.userId, clientId: accessToken.clientId };
}

async function resolveOAuthUser(authHeader: string | null, workspaceSlug = ""): Promise<ResolvedMcpUser | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  if (!token || token.startsWith("gn_agt_")) return null;
  if (token.startsWith("gn_usr_")) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const userToken = await prisma.userMcpToken.findUnique({
      where: { hashedToken: tokenHash },
      include: { workspace: { select: { slug: true } } },
    });
    // Global personal tokens predate the workspace boundary. Rejecting them
    // forces a reissue in the active workspace instead of guessing a scope.
    if (!userToken || userToken.revokedAt || !workspaceSlug || userToken.workspace?.slug !== workspaceSlug) return null;
    void prisma.userMcpToken.update({ where: { id: userToken.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    return { userId: userToken.userId, tokenId: userToken.id };
  }
  return resolveOAuthAccessToken(token);
}

async function resolveOAuthAgent(token: string): Promise<ResolvedAgent | null> {
  const accessToken = await resolveOAuthAccessToken(token);
  if (!accessToken) return null;

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

  return { id: agent.id, name: agent.name, enabled: agent.enabled, userId: accessToken.userId };
}

function prepareMcpSession(c: any, principalKey: string | null) {
  if (!principalKey) return { ok: true as const };

  cleanupExpiredMcpSessions();
  const now = Date.now();
  const requestedId = c.req.header("mcp-session-id") ?? c.req.header("Mcp-Session-Id") ?? "";
  if (requestedId) {
    const existing = mcpSessions.get(requestedId);
    if (!existing || existing.expiresAt <= now) {
      return { ok: false as const, status: 404, message: "Mcp-Session-Id is unknown or expired; retry without the header to create a new session" };
    }
    if (existing.principalKey !== principalKey) {
      return { ok: false as const, status: 409, message: "Mcp-Session-Id belongs to a different authenticated principal" };
    }
    existing.lastSeenAt = now;
    existing.expiresAt = now + MCP_SESSION_TTL_MS;
    c.header("Mcp-Session-Id", requestedId);
    return { ok: true as const };
  }

  const sessionId = randomUUID();
  mcpSessions.set(sessionId, {
    principalKey,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + MCP_SESSION_TTL_MS,
  });
  c.header("Mcp-Session-Id", sessionId);
  return { ok: true as const };
}

function auditIdentity(agent: ResolvedAgent): { agentId: string; userId?: string } {
  return agent.userId ? { agentId: agent.id, userId: agent.userId } : { agentId: agent.id };
}

async function selectableAgentsForUser(userId: string, wsSlug = "") {
  let agents = await connectableAgentsFor(userId);
  if (wsSlug) agents = agents.filter((agent) => agent.workspace?.slug === wsSlug);
  return agents;
}

async function resolveUserSelectedAgent(userId: string, args: Record<string, unknown>, wsSlug = ""): Promise<
  | { ok: true; agent: ResolvedAgent }
  | { ok: false; status: number; code: number; message: string; agents?: Awaited<ReturnType<typeof selectableAgentsForUser>> }
> {
  const requestedAgentId = String(args.acting_agent_id ?? args.actingAgentId ?? args.agent_id ?? args.agentId ?? "").trim();
  const candidates = await selectableAgentsForUser(userId, wsSlug);
  if (requestedAgentId) {
    const visible = candidates.find((agent) => agent.id === requestedAgentId);
    if (!visible) {
      return {
        ok: false,
        status: 403,
        code: -32010,
        message: wsSlug
          ? `agent_id is not usable by this user in workspace '${wsSlug}'`
          : "agent_id is not usable by this user",
        agents: candidates,
      };
    }
    const agent = await prisma.agent.findUnique({ where: { id: requestedAgentId } });
    if (!agent || !agent.enabled || (agent.expiresAt && agent.expiresAt < new Date()) || !(await userMayUseAgent(userId, agent))) {
      return { ok: false, status: 403, code: -32010, message: "agent_id is no longer usable by this user", agents: candidates };
    }
    return { ok: true, agent: { id: agent.id, name: agent.name, enabled: agent.enabled, userId } };
  }
  if (candidates.length === 1) {
    const agent = await prisma.agent.findUnique({ where: { id: candidates[0].id } });
    if (agent && agent.enabled && !(agent.expiresAt && agent.expiresAt < new Date()) && await userMayUseAgent(userId, agent)) {
      return { ok: true, agent: { id: agent.id, name: agent.name, enabled: agent.enabled, userId } };
    }
  }
  if (!candidates.length) {
    return {
      ok: false,
      status: 403,
      code: -32010,
      message: wsSlug ? `no enabled agents available for this user in workspace '${wsSlug}'` : "no enabled agents available for this user",
    };
  }
  return {
    ok: false,
    status: 400,
    code: -32602,
    message: "agent_id is required because this user can use multiple agents. Call grantry_list_user_agents first.",
    agents: candidates,
  };
}

async function userModeToolContext(userId: string, args: Record<string, unknown>, wsSlug: string): Promise<
  | { ok: true; agent: ResolvedAgent; ctx: SystemToolContext }
  | { ok: false; response: any; status: number }
> {
  const selected = await resolveUserSelectedAgent(userId, args, wsSlug);
  if (!selected.ok) {
    return {
      ok: false,
      status: selected.status,
      response: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: selected.code,
          message: selected.message,
          data: selected.agents ? {
            agents: selected.agents.map((agent) => ({
              agent_id: agent.id,
              name: agent.name,
              description: agent.description,
              workspace: agent.workspace,
            })),
          } : undefined,
        },
      },
    };
  }
  const self = await prisma.agent.findUnique({ where: { id: selected.agent.id }, select: { ownerId: true, workspaceId: true } });
  if (!self) {
    return {
      ok: false,
      status: 500,
      response: { jsonrpc: "2.0", id: null, error: { code: -32011, message: "selected agent vanished" } },
    };
  }
  return { ok: true, agent: selected.agent, ctx: { agentId: selected.agent.id, ownerId: self.ownerId, workspaceId: self.workspaceId, userId } };
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

function providerRequiresWorkspaceOAuthApp(provider: string) {
  const providerDef = PROVIDERS[provider];
  return Array.isArray(providerDef?.authTypes)
    && providerDef.authTypes.includes("oauth")
    && providerDef.oauthAppOwner === "workspace";
}

function oauthEnvPrefix(provider: string) {
  return provider === "meta_ads_platform" ? "META_ADS" : provider.toUpperCase();
}

function oauthEnvClientConfig(provider: string) {
  const envPrefix = oauthEnvPrefix(provider);
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
    google_slides: ["GOOGLE_CLIENT_ID"],
    google_forms: ["GOOGLE_CLIENT_ID"],
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
    google_slides: ["GOOGLE_CLIENT_SECRET"],
    google_forms: ["GOOGLE_CLIENT_SECRET"],
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

async function oauthClientConfigForRefresh(
  provider: string,
  workspaceId: string | null | undefined,
  oauthAppCredentialId?: string | null,
) {
  if (workspaceId && providerRequiresWorkspaceOAuthApp(provider)) {
    // A refresh token only works with the OAuth app that issued it. Prefer the
    // app recorded on the credential; fall back to "the workspace's only app"
    // for rows minted before that binding existed. With several apps and no
    // binding we refuse rather than guess — picking the most recent one is how
    // a swapped app used to break every older connection silently.
    const boundId = String(oauthAppCredentialId ?? "").trim();
    const credential = boundId
      ? await prisma.providerCredential.findFirst({
          where: { id: boundId, workspaceId, provider, authType: "oauth_app", enabled: true },
        })
      : await (async () => {
          const apps = await prisma.providerCredential.findMany({
            where: { workspaceId, provider, authType: "oauth_app", enabled: true },
            orderBy: { updatedAt: "desc" },
            take: 2,
          });
          return apps.length === 1 ? apps[0] : null;
        })();
    if (boundId && !credential) {
      return { source: "app_unavailable" as const, clientId: "", clientSecret: "", clientAuthMethod: PROVIDERS[provider]?.oauthClientAuthMethod || "CLIENT_SECRET_POST" };
    }
    if (!boundId && !credential) {
      const appCount = await prisma.providerCredential.count({
        where: { workspaceId, provider, authType: "oauth_app", enabled: true },
      });
      if (appCount > 1) {
        return { source: "app_ambiguous" as const, clientId: "", clientSecret: "", clientAuthMethod: PROVIDERS[provider]?.oauthClientAuthMethod || "CLIENT_SECRET_POST" };
      }
    }
    if (credential) {
      const meta = safeJsonObject(credential.credentialMetadata);
      const clientId = typeof meta.oauthClientId === "string" ? meta.oauthClientId.trim() : "";
      if (clientId) {
        return {
          source: "workspace" as const,
          clientId,
          clientSecret: decrypt(credential.encryptedCredential),
          clientAuthMethod: typeof meta.oauthClientAuthMethod === "string" ? meta.oauthClientAuthMethod : (PROVIDERS[provider]?.oauthClientAuthMethod || "CLIENT_SECRET_POST"),
        };
      }
    }
  }
  if (providerRequiresWorkspaceOAuthApp(provider)) {
    return { source: "workspace_missing" as const, clientId: "", clientSecret: "", clientAuthMethod: PROVIDERS[provider]?.oauthClientAuthMethod || "CLIENT_SECRET_POST" };
  }
  return { source: "env" as const, ...oauthEnvClientConfig(provider) };
}

async function refreshOAuthToken(
  provider: string,
  refreshToken: string,
  workspaceId?: string | null,
  oauthAppCredentialId?: string | null,
) {
  const providerDef = PROVIDERS[provider];
  if (!providerDef?.oauthTokenUrl) throw new Error(`OAuth refresh is not configured for provider: ${provider}`);
  // Most providers refresh at the token endpoint; some (e.g. Figma) use a
  // distinct refresh URL. Prefer oauthRefreshUrl when the registry sets it.
  const refreshUrl = providerDef.oauthRefreshUrl || providerDef.oauthTokenUrl;

  const envPrefix = provider.toUpperCase();
  const { clientId, clientSecret, clientAuthMethod, source } = await oauthClientConfigForRefresh(provider, workspaceId, oauthAppCredentialId);
  if (!clientId || !clientSecret) {
    if (source === "app_unavailable") {
      throw new Error(`${provider} OAuth app for this credential is missing or disabled: reconnect it against a registered ${provider} OAuth app`);
    }
    if (source === "app_ambiguous") {
      throw new Error(`${provider} has several OAuth apps in this workspace and this credential predates app binding: reconnect it so it records which app issued it`);
    }
    if (providerRequiresWorkspaceOAuthApp(provider)) {
      throw new Error(`${provider} OAuth refresh credentials missing: configure this workspace's OAuth app credential`);
    }
    throw new Error(`${provider} OAuth refresh credentials missing: set ${envPrefix}_CLIENT_ID and ${envPrefix}_CLIENT_SECRET`);
  }
  // Observability: surface which OAuth client (and its source: workspace-DB vs env)
  // actually performs the refresh. A wrong/stale client here was otherwise invisible —
  // this is the blind spot that hid the "workspace credential shadows env" bug
  // (2026-06-20). The /oauth/start path already logs the same; this covers refresh.
  console.log("[oauth] refresh client resolved", {
    provider,
    source,
    clientId: clientId.length > 14 ? `${clientId.slice(0, 8)}...${clientId.slice(-10)}` : clientId,
  });

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
    const resp = await fetch(refreshUrl, {
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

export async function credentialForConnection(conn: {
  id: string;
  provider: string;
  encryptedCredential: string;
  encryptedServerCredential: string | null;
  credentialId: string | null;
  authType: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  workspaceId?: string | null;
  oauthAppCredentialId?: string | null;
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
  // The shared ProviderCredential is the row the tokens actually live on, so it
  // carries the authoritative app binding; the connection's own column covers
  // connections that never got promoted to a shared credential.
  const oauthAppCredentialId = shared?.oauthAppCredentialId ?? conn.oauthAppCredentialId ?? null;
  const refreshed = await refreshOAuthToken(conn.provider, decrypt(refreshToken), conn.workspaceId, oauthAppCredentialId);
  const data = {
    encryptedCredential: encrypt(refreshed.access_token),
    accessTokenExpiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
    ...(await credentialMetadataForStorage(conn.provider, conn.authType, refreshed.access_token)),
    ...(refreshed.refresh_token ? { refreshToken: encrypt(refreshed.refresh_token) } : {}),
  };
  if (conn.credentialId) {
    await prisma.$transaction([
      prisma.providerCredential.update({ where: { id: conn.credentialId }, data: providerCredentialData(data) }),
      prisma.connection.updateMany({ where: { credentialId: conn.credentialId }, data: connectionCredentialData(data) }),
    ]);
  } else {
    await prisma.connection.update({ where: { id: conn.id }, data: connectionCredentialData(data) });
  }
  return refreshed.access_token;
}

const handleMcpPost = async (c: any) => {
  const started = Date.now();
  const auth = c.req.header("authorization") ?? null;
  const userMode = isUserMcpMode(c);
  const wsSlug = String(c.req.param("ws") ?? "").trim();
  const userPrincipal = userMode ? await resolveOAuthUser(auth, wsSlug) : null;
  let agent = userMode ? null : await resolveAgent(auth);
  const configuredScope = configuredMcpScope(c);
  c.header("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

  if (userMode && !wsSlug) {
    return c.json({
      jsonrpc: "2.0", id: null,
      error: { code: -32003, message: "Personal MCP tokens require a workspace-locked endpoint: /mcp/u/w/<workspace>." },
    }, 403);
  }

  // MCP authorization spec: unauthenticated (or invalid-token) requests get
  // 401 + WWW-Authenticate pointing at the protected-resource metadata for
  // THIS resource URL (RFC 9728 path insertion — /mcp/w/<ws> gets its own).
  // This is what triggers the OAuth flow in remote clients like claude.ai
  // and Claude Desktop. Static gn_agt_ tokens authenticate as before.
  if (!agent && !userPrincipal) {
    const suppliedPersonalToken = userMode && auth?.startsWith("Bearer gn_usr_");
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
        message: suppliedPersonalToken
          ? `Unauthorized: this personal MCP token is invalid, revoked, or is not scoped to workspace '${wsSlug}'. Open MCP tokens for that workspace, rotate the token, and copy the new configuration.`
          : "Unauthorized: pass 'Authorization: Bearer gn_agt_...' or complete the OAuth flow advertised in WWW-Authenticate",
      },
    }, 401);
  }

  // Workspace-locked endpoint (/mcp/w/<slug>): the resolved agent must live
  // in that workspace. Lets one desktop hold parallel connectors for
  // different workspaces (client A / client B) without cross-talk.
  if (wsSlug && agent) {
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

  const session = prepareMcpSession(c, userPrincipal ? `user:${userPrincipal.userId}` : (agent ? `agent:${agent.id}` : null));
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
    if (userPrincipal) {
      const agents = await selectableAgentsForUser(userPrincipal.userId, wsSlug);
      const allConnections: Awaited<ReturnType<typeof connectionsForAgent>> = [];
      const agentOptionsByTool = new Map<string, { id: string; name: string }[]>();
      for (const candidate of agents) {
        const conns = (await connectionsForAgent(candidate.id)).filter((conn) => !configuredScope || conn.scope === configuredScope);
        allConnections.push(...conns);
        for (const conn of conns) {
          for (const tool of conn.tools) {
            const options = agentOptionsByTool.get(tool) ?? [];
            if (!options.some((option) => option.id === candidate.id)) options.push({ id: candidate.id, name: candidate.name });
            agentOptionsByTool.set(tool, options);
          }
        }
      }
      return c.json({ jsonrpc: "2.0", id, result: {
        tools: buildToolList(allConnections, new Map(), {
          userMode: true,
          requireAgentId: agents.length > 1,
          agentOptionsByTool,
        }),
      } });
    }
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
    if (userPrincipal) {
      const agents = await selectableAgentsForUser(userPrincipal.userId, wsSlug);
      const resultAgents = [];
      for (const candidate of agents) {
        resultAgents.push({
          agent_id: candidate.id,
          name: candidate.name,
          description: candidate.description,
          workspace: candidate.workspace,
          connections: (await connectionsForAgent(candidate.id)).filter((conn) => !configuredScope || conn.scope === configuredScope),
        });
      }
      return c.json({ jsonrpc: "2.0", id, result: { agents: resultAgents } });
    }
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
    let systemCtx: SystemToolContext | undefined = userPrincipal ? { userId: userPrincipal.userId, workspaceSlug: wsSlug } : undefined;

    if (userPrincipal && !["grantry/get_skill", "grantry/get_providers", "grantry/list_user_agents"].includes(toolName)) {
      // `grantry/delegate` and the admin tools both take `agent_id` as the
      // *target* agent, so it must not double as the acting-agent selector.
      const selectionArgs = agentIdIsToolTarget(toolName)
        ? { acting_agent_id: (args as any).acting_agent_id ?? (args as any).actingAgentId }
        : args;
      const selected = await userModeToolContext(userPrincipal.userId, selectionArgs, wsSlug);
      if (!selected.ok) {
        selected.response.id = id;
        return c.json(selected.response, selected.status as any);
      }
      agent = selected.agent;
      systemCtx = selected.ctx;
    }

    // grantry/delegate executes a real provider call, so it runs through the
    // authenticated path below (rate limit + audit), not the metadata helper.
    if (SYSTEM_TOOLS.includes(toolName as any) && toolName !== "grantry/delegate") {
      if (AUTHED_SYSTEM_TOOLS.has(toolName) && !agent && !systemCtx?.userId) {
        return c.json({
          jsonrpc: "2.0", id,
          error: { code: -32001, message: "authentication required: pass 'Authorization: Bearer gn_agt_...'" },
        }, 401);
      }
      // Resolve identity for any authenticated caller (not just AUTHED tools):
      // the public metadata tools (e.g. get_providers) optionally enrich their
      // output with the caller's scopes when a token is present.
      if (!systemCtx && agent) {
        const self = await prisma.agent.findUnique({ where: { id: agent.id }, select: { ownerId: true, workspaceId: true } });
        if (self) systemCtx = { ...auditIdentity(agent), ownerId: self.ownerId, workspaceId: self.workspaceId, userId: agent.userId ?? undefined };
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
    const providerArgs = stripActingAgentSelector(args as Record<string, unknown>, { userMode, toolName });

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
          ...auditIdentity(agent!),
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
        ...auditIdentity(agent),
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
          ...auditIdentity(agent),
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
          ...auditIdentity(agent),
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
          ...auditIdentity(agent),
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
          ...auditIdentity(agent), delegatedById: agent.id, delegationId: grant!.id,
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

      const innerArgs = stripActingAgentSelector(args as Record<string, unknown>, { userMode, toolName });
      delete innerArgs.grant_token;
      delete innerArgs.grantToken;
      try {
        const credential = await credentialForConnection(conn);

        // Burn the single use up front: a failed provider call still consumes the grant.
        await prisma.delegationGrant.update({ where: { id: grant!.id }, data: { status: "consumed", consumedAt: now } });
        const result = await dispatchProviderTool(decision.provider, toolName, innerArgs, credential, conn, agent.id);
        void recordRuntimeCallHealth(conn, { ok: true });
        await prisma.auditLog.create({ data: {
          agentId: grant!.targetAgentId, userId: agent.userId ?? undefined, delegatedById: agent.id, delegationId: grant!.id,
          connectionId: conn.id,
          provider: decision.provider, tool: toolName, scope, status: "ok",
          responseSummary: JSON.stringify({ delegatedBy: agent.name, connectionId: conn.id, result: (result as any)?.auditSummary ?? result }).slice(0, 500),
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
        void recordRuntimeCallHealth(conn, { ok: false, errorMessage: errMsg });
        await prisma.auditLog.create({ data: {
          agentId: grant!.targetAgentId, userId: agent.userId ?? undefined, delegatedById: agent.id, delegationId: grant!.id,
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
          ...auditIdentity(agent),
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
    // Resolving the credential can itself fail (expired refresh token, dead
    // DWD key). Surface that as a normal tool error instead of an opaque 500,
    // and let the health snapshot reflect it so the dashboard shows broken.
    let token: string;
    try {
      token = await credentialForConnection(conn);
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      void recordRuntimeCallHealth(conn, { ok: false, errorMessage: errMsg });
      await prisma.auditLog.create({
        data: {
          ...auditIdentity(agent),
          connectionId: conn.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "error",
          errorMessage: errMsg.slice(0, 2000),
          requestArgs: maskAuditArgs(args),
          durationMs: Date.now() - started,
        },
      }).catch(() => {});
      return c.json({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Error: ${errMsg}` }], isError: true },
      });
    }

    // 4) Dispatch to provider-specific tool
    try {
      const result = await dispatchProviderTool(decision.provider, toolName, providerArgs, token, conn, agent.id);
      void recordRuntimeCallHealth(conn, { ok: true });

      await prisma.auditLog.create({
        data: {
          ...auditIdentity(agent),
          connectionId: conn.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "ok",
          responseSummary: JSON.stringify({ authType: decision.authType, connectionId: conn.id, result: (result as any)?.auditSummary ?? result }).slice(0, 500),
          requestArgs: maskAuditArgs(providerArgs),
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
      void recordRuntimeCallHealth(conn, { ok: false, errorMessage: errMsg });
      await prisma.auditLog.create({
        data: {
          ...auditIdentity(agent),
          connectionId: conn.id,
          provider: decision.provider,
          tool: toolName,
          scope,
          status: "error",
          errorMessage: errMsg.slice(0, 2000),
          requestArgs: maskAuditArgs(providerArgs),
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
// User-mode MCP: the workspace-locked form can act through only agents the
// user may use in that workspace. Provider calls select an agent with
// `agent_id` (or auto-pick when there is exactly one candidate). Existing
// agent-token routes above remain unchanged for already distributed clients.
mcpApp.post("/u", handleMcpPost);
mcpApp.post("/u/w/:ws", handleMcpPost);
mcpApp.post("/u/s/:scope", handleMcpPost);
mcpApp.post("/u/w/:ws/s/:scope", handleMcpPost);
