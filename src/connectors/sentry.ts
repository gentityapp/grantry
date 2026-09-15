// Sentry connector - auth token via Authorization: Bearer <token>.
// Targets the Sentry Web API (/api/0). sentry.io (US) is the default host; the
// EU data region (https://de.sentry.io) and self-hosted installations pass
// base_url in the credential. Generic calls go through sentry/request.
//
// Credential: paste a User Auth Token or an Internal Integration token
// (sntryu_... / hex), or JSON
//   {"token":"sntryu_...","organization":"acme","base_url":"https://de.sentry.io"}
// `organization` becomes the default org slug so agents do not have to pass it
// on every call. Organization Auth Tokens (sntrys_...) only carry org:ci and
// cannot read issues.
// Docs: https://docs.sentry.io/api/
const SENTRY_DEFAULT_HOST = "https://sentry.io";
const SENTRY_TIMEOUT_MS = 30_000;

type SentryArgs = Record<string, unknown>;

export type SentryCredential = {
  token: string;
  apiBase: string;
  organization?: string;
};

// Accepts a host ("https://de.sentry.io") or an API root ("https://de.sentry.io/api/0").
export function sentryApiBase(raw: string | undefined) {
  const host = String(raw ?? "").trim().replace(/\/+$/, "") || SENTRY_DEFAULT_HOST;
  return host.endsWith("/api/0") ? host : `${host}/api/0`;
}

export function parseSentryCredential(raw: string): SentryCredential {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.startsWith("{")) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Sentry credential JSON is invalid; expected {"token":"sntryu_...","organization":"your-org"}');
    }
    const token = String(parsed.token ?? parsed.auth_token ?? parsed.api_key ?? parsed.apiKey ?? "").trim();
    if (!token) throw new Error("Sentry credential JSON must include token");
    const organization = String(parsed.organization ?? parsed.org ?? parsed.organization_slug ?? "").trim();
    return {
      token,
      apiBase: sentryApiBase(parsed.base_url ?? parsed.baseUrl ?? parsed.url),
      ...(organization ? { organization } : {}),
    };
  }
  if (!trimmed) throw new Error("Sentry auth token is required");
  return { token: trimmed, apiBase: sentryApiBase(undefined) };
}

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

// Sentry paginates with RFC 5988 Link headers:
//   <...&cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"
function nextCursor(link: string | null) {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    if (!/results="true"/.test(part)) return null;
    return part.match(/cursor="([^"]+)"/)?.[1] ?? null;
  }
  return null;
}

async function request(
  credential: SentryCredential,
  method: string,
  path: string,
  body: unknown,
  tool: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENTRY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[sentry] request", { path, tool });
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.token}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`${credential.apiBase}${path}`, init);
    console.log("[sentry] response", { path, tool, status: r.status, durationMs: Date.now() - started });
    const j: any = await readJsonResponse(r);
    if (!r.ok) {
      const detail = j?.detail ?? j;
      const hint = r.status === 403 ? " (the token is missing a scope: reads need org:read/project:read/event:read, sentry/update_issue needs event:write)" : "";
      throw new Error(`Sentry ${tool} failed: ${r.status} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 1000)}${hint}`);
    }
    return { json: j, next_cursor: nextCursor(r.headers.get("link")) };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`Sentry request timed out after ${SENTRY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function queryString(params: Record<string, unknown>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) if (item !== undefined && item !== null && item !== "") qs.append(k, String(item));
    } else {
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function seg(value: string) {
  return encodeURIComponent(value);
}

function organization(args: SentryArgs, credential: SentryCredential) {
  const org = String(args.organization ?? args.org ?? args.organization_slug ?? credential.organization ?? "").trim();
  if (!org) {
    throw new Error("organization is required (org slug from sentry.io/organizations/<slug>/); run sentry/list_organizations, or store it in the credential as {\"token\",\"organization\"}");
  }
  return org;
}

function requireArg(args: SentryArgs, key: string, aliases: string[] = []) {
  for (const k of [key, ...aliases]) {
    const value = String(args[k] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${key} is required`);
}

// Issue ids are numeric; short ids (PROJECT-1A) are resolved through the
// org shortids endpoint so agents can paste what they see in the Sentry UI.
async function resolveIssueId(credential: SentryCredential, org: string, raw: string, tool: string) {
  if (/^\d+$/.test(raw)) return raw;
  const { json } = await request(credential, "GET", `/organizations/${seg(org)}/shortids/${seg(raw)}/`, undefined, tool);
  const id = String(json?.groupId ?? json?.group?.id ?? "").trim();
  if (!id) throw new Error(`Sentry short id ${raw} did not resolve to an issue`);
  return id;
}

function limitArg(args: SentryArgs) {
  const n = Number(args.limit ?? args.per_page ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : undefined;
}

function summarizeIssue(i: any) {
  return {
    id: i?.id,
    short_id: i?.shortId,
    title: i?.title,
    culprit: i?.culprit,
    level: i?.level,
    status: i?.status,
    substatus: i?.substatus,
    is_unhandled: i?.isUnhandled,
    count: i?.count,
    user_count: i?.userCount,
    first_seen: i?.firstSeen,
    last_seen: i?.lastSeen,
    project: i?.project?.slug,
    assigned_to: i?.assignedTo ? { type: i.assignedTo.type, name: i.assignedTo.name } : null,
    permalink: i?.permalink,
  };
}

const MAX_FRAMES = 20;

function summarizeFrames(frames: any[]) {
  const all = Array.isArray(frames) ? frames : [];
  const inApp = all.filter((f) => f?.inApp);
  // Sentry orders frames oldest-first; the crash site is at the end.
  const picked = (inApp.length ? inApp : all).slice(-MAX_FRAMES);
  return {
    total_frames: all.length,
    in_app_frames: inApp.length,
    frames: picked.map((f: any) => ({
      filename: f?.filename ?? f?.absPath,
      function: f?.function,
      line: f?.lineNo,
      column: f?.colNo,
      in_app: f?.inApp,
      context_line: typeof f?.context === "object" && Array.isArray(f.context)
        ? (f.context.find((c: any) => Array.isArray(c) && c[0] === f.lineNo)?.[1] ?? null)
        : null,
    })),
  };
}

// Events are large (breadcrumbs, full context, request bodies, end-user data).
// Return what an agent needs to triage: the exception chain with in-app frames,
// message, release/environment and tags. Use sentry/request for the raw event.
function summarizeEvent(e: any) {
  const entries = Array.isArray(e?.entries) ? e.entries : [];
  const exceptionEntry = entries.find((x: any) => x?.type === "exception");
  const messageEntry = entries.find((x: any) => x?.type === "message");
  const exceptions = (exceptionEntry?.data?.values ?? []).map((v: any) => ({
    type: v?.type,
    value: v?.value,
    module: v?.module,
    mechanism: v?.mechanism ? { type: v.mechanism.type, handled: v.mechanism.handled } : undefined,
    stacktrace: v?.stacktrace ? summarizeFrames(v.stacktrace.frames) : null,
  }));
  const tags = Array.isArray(e?.tags) ? Object.fromEntries(e.tags.map((t: any) => [t?.key, t?.value])) : e?.tags;
  return {
    event_id: e?.eventID ?? e?.id,
    issue_id: e?.groupID,
    title: e?.title,
    message: e?.message || messageEntry?.data?.formatted || null,
    platform: e?.platform,
    date_created: e?.dateCreated,
    release: e?.release?.version ?? e?.release ?? null,
    environment: tags?.environment ?? null,
    exceptions,
    tags,
    notes: [
      "Frames are the in-app frames nearest the crash (oldest first, last is the crash site). Breadcrumbs, request data and end-user fields are omitted; call sentry/request on the same path for the raw event.",
    ],
  };
}

export async function callSentryTool(tool: string, args: SentryArgs, rawCredential: string) {
  const credential = parseSentryCredential(rawCredential);

  if (tool === "sentry/list_organizations") {
    const { json, next_cursor } = await request(credential, "GET", `/organizations/${queryString({ cursor: args.cursor })}`, undefined, tool);
    const orgs = (Array.isArray(json) ? json : []).map((o: any) => ({ id: o?.id, slug: o?.slug, name: o?.name, date_created: o?.dateCreated }));
    return { structuredContent: { organizations: orgs, next_cursor, default_organization: credential.organization ?? null } };
  }

  if (tool === "sentry/list_projects") {
    const org = organization(args, credential);
    const { json, next_cursor } = await request(credential, "GET", `/organizations/${seg(org)}/projects/${queryString({ query: args.query, cursor: args.cursor })}`, undefined, tool);
    const projects = (Array.isArray(json) ? json : []).map((p: any) => ({ id: p?.id, slug: p?.slug, name: p?.name, platform: p?.platform, date_created: p?.dateCreated }));
    return { structuredContent: { organization: org, projects, next_cursor } };
  }

  if (tool === "sentry/list_issues") {
    const org = organization(args, credential);
    const qs = queryString({
      query: args.query ?? "is:unresolved",
      project: args.project,
      environment: args.environment,
      statsPeriod: args.stats_period ?? args.statsPeriod,
      start: args.start,
      end: args.end,
      sort: args.sort,
      limit: limitArg(args),
      cursor: args.cursor,
    });
    const { json, next_cursor } = await request(credential, "GET", `/organizations/${seg(org)}/issues/${qs}`, undefined, tool);
    const issues = (Array.isArray(json) ? json : []).map(summarizeIssue);
    return { structuredContent: { organization: org, returned: issues.length, issues, next_cursor } };
  }

  if (tool === "sentry/get_issue") {
    const org = organization(args, credential);
    const issueId = await resolveIssueId(credential, org, requireArg(args, "issue_id", ["id", "short_id"]), tool);
    const { json } = await request(credential, "GET", `/organizations/${seg(org)}/issues/${seg(issueId)}/`, undefined, tool);
    return {
      structuredContent: {
        ...summarizeIssue(json),
        metadata: json?.metadata,
        type: json?.issueType ?? json?.type,
        platform: json?.platform,
        first_release: json?.firstRelease?.version ?? null,
        last_release: json?.lastRelease?.version ?? null,
        tags: Array.isArray(json?.tags) ? json.tags.map((t: any) => ({ key: t?.key, top_values: (t?.topValues ?? []).slice(0, 5).map((v: any) => ({ value: v?.value, count: v?.count })) })) : undefined,
      },
    };
  }

  if (tool === "sentry/list_issue_events") {
    const org = organization(args, credential);
    const issueId = await resolveIssueId(credential, org, requireArg(args, "issue_id", ["id", "short_id"]), tool);
    const qs = queryString({ query: args.query, environment: args.environment, statsPeriod: args.stats_period ?? args.statsPeriod, cursor: args.cursor });
    const { json, next_cursor } = await request(credential, "GET", `/organizations/${seg(org)}/issues/${seg(issueId)}/events/${qs}`, undefined, tool);
    const limit = limitArg(args);
    const rows = (Array.isArray(json) ? json : []).map((e: any) => ({
      event_id: e?.eventID ?? e?.id,
      title: e?.title,
      message: e?.message,
      date_created: e?.dateCreated,
      platform: e?.platform,
      tags: Array.isArray(e?.tags) ? Object.fromEntries(e.tags.map((t: any) => [t?.key, t?.value])) : undefined,
    }));
    const events = limit ? rows.slice(0, limit) : rows;
    return { structuredContent: { organization: org, issue_id: issueId, returned: events.length, events, next_cursor } };
  }

  if (tool === "sentry/get_issue_event") {
    const org = organization(args, credential);
    const issueId = await resolveIssueId(credential, org, requireArg(args, "issue_id", ["id", "short_id"]), tool);
    const eventId = String(args.event_id ?? "latest").trim() || "latest";
    const { json } = await request(credential, "GET", `/organizations/${seg(org)}/issues/${seg(issueId)}/events/${seg(eventId)}/`, undefined, tool);
    return { structuredContent: summarizeEvent(json) };
  }

  if (tool === "sentry/update_issue") {
    const org = organization(args, credential);
    const issueId = await resolveIssueId(credential, org, requireArg(args, "issue_id", ["id", "short_id"]), tool);
    const body: Record<string, unknown> = {};
    if (args.status !== undefined) body.status = args.status;
    if (args.substatus !== undefined) body.substatus = args.substatus;
    if (args.status_details !== undefined || args.statusDetails !== undefined) body.statusDetails = args.status_details ?? args.statusDetails;
    if (args.assigned_to !== undefined || args.assignedTo !== undefined) body.assignedTo = args.assigned_to ?? args.assignedTo;
    if (args.has_seen !== undefined || args.hasSeen !== undefined) body.hasSeen = args.has_seen ?? args.hasSeen;
    if (args.is_bookmarked !== undefined || args.isBookmarked !== undefined) body.isBookmarked = args.is_bookmarked ?? args.isBookmarked;
    if (args.is_subscribed !== undefined || args.isSubscribed !== undefined) body.isSubscribed = args.is_subscribed ?? args.isSubscribed;
    if (args.is_public !== undefined || args.isPublic !== undefined) body.isPublic = args.is_public ?? args.isPublic;
    if (!Object.keys(body).length) throw new Error("Pass at least one of status, substatus, status_details, assigned_to, has_seen, is_bookmarked, is_subscribed, is_public");
    const { json } = await request(credential, "PUT", `/organizations/${seg(org)}/issues/${seg(issueId)}/`, body, tool);
    return { structuredContent: { ...summarizeIssue(json), updated: Object.keys(body) } };
  }

  if (tool === "sentry/list_releases") {
    const org = organization(args, credential);
    const qs = queryString({ query: args.query, project: args.project, environment: args.environment, per_page: limitArg(args), cursor: args.cursor });
    const { json, next_cursor } = await request(credential, "GET", `/organizations/${seg(org)}/releases/${qs}`, undefined, tool);
    const releases = (Array.isArray(json) ? json : []).map((r: any) => ({
      version: r?.version,
      short_version: r?.shortVersion,
      date_created: r?.dateCreated,
      date_released: r?.dateReleased,
      first_event: r?.firstEvent,
      last_event: r?.lastEvent,
      new_groups: r?.newGroups,
      projects: Array.isArray(r?.projects) ? r.projects.map((p: any) => p?.slug) : undefined,
    }));
    return { structuredContent: { organization: org, releases, next_cursor } };
  }

  throw new Error(`Unknown Sentry tool: ${tool}`);
}
