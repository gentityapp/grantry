// Seminar Portal connector — API key via Authorization: Bearer.
//
// A Japanese IT/SaaS/AI seminar aggregator. It collects listings from event
// platforms, B2B media and vendors' own sites, then normalizes each seminar's
// technologies onto one vocabulary so two seminars are comparable — which is
// what makes "recommend something for someone who works with AWS" answerable.
//
// The base URL is part of the credential: this is a self-hosted service, so a
// workspace points its connection at its own deployment.
const DEFAULT_BASE = "https://seminar.rootteam.co.jp";
const SEMINAR_TIMEOUT_MS = 15_000;

type SeminarArgs = Record<string, unknown>;

type Credential = { apiKey: string; baseUrl: string };

/**
 * The credential is either a bare API key or JSON carrying a base URL too.
 * Bare keys keep the common case a paste; the JSON form is how a second
 * deployment gets pointed somewhere else.
 */
function parseCredential(credential: string): Credential {
  const raw = credential.trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
      const baseUrl = String(parsed.base_url ?? parsed.baseUrl ?? "").trim();
      return { apiKey, baseUrl: (baseUrl || DEFAULT_BASE).replace(/\/+$/, "") };
    }
  } catch {
    // plain API key
  }
  return { apiKey: raw, baseUrl: DEFAULT_BASE };
}

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function optionalArg(args: SeminarArgs, key: string, aliases: string[] = []): string | undefined {
  for (const k of [key, ...aliases]) {
    const v = args?.[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

/**
 * `tech` accepts a list or a comma-separated string, because a model calling
 * this will produce either and a rejected shape costs a whole turn.
 */
function techValues(args: SeminarArgs): string[] {
  const raw = args?.tech ?? args?.technologies ?? args?.interests;
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((t) => String(t).trim()).filter(Boolean);
}

async function request(
  credential: string,
  path: string,
  params: Record<string, string | string[] | undefined>,
  tool: string,
) {
  const { apiKey, baseUrl } = parseCredential(credential);
  if (!apiKey) throw new Error("Seminar Portal credential must include an api_key");

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    // Repeat the parameter rather than joining: the API reads ?tech=a&tech=b.
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEMINAR_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[seminar_portal] request", { tool, path });
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    console.log("[seminar_portal] response", {
      tool,
      status: response.status,
      durationMs: Date.now() - started,
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      const detail = typeof body === "object" ? JSON.stringify(body).slice(0, 300) : String(body);
      throw new Error(`Seminar Portal ${response.status} for ${path}: ${detail}`);
    }
    return body;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[seminar_portal] failed", {
      tool,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${SEMINAR_TIMEOUT_MS}ms` : String(e?.message ?? e),
    });
    if (aborted) throw new Error(`Seminar Portal request timed out after ${SEMINAR_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callSeminarPortalTool(tool: string, args: SeminarArgs, credential: string) {
  if (tool === "seminar_portal/list_tech") {
    return { structuredContent: await request(credential, "/api/v1/tech", {}, tool) };
  }

  if (tool === "seminar_portal/search") {
    const tech = techValues(args);
    return {
      structuredContent: await request(
        credential,
        "/api/v1/seminars",
        {
          q: optionalArg(args, "q", ["query", "keyword"]),
          category: optionalArg(args, "category"),
          tech: tech.length ? tech : undefined,
          tech_match: optionalArg(args, "tech_match", ["techMatch"]),
          online: optionalArg(args, "online"),
          from: optionalArg(args, "from"),
          to: optionalArg(args, "to"),
          include_past: optionalArg(args, "include_past", ["includePast"]),
          limit: optionalArg(args, "limit"),
          offset: optionalArg(args, "offset"),
        },
        tool,
      ),
    };
  }

  if (tool === "seminar_portal/get") {
    const id = optionalArg(args, "id", ["seminar_id", "seminarId"]);
    if (!id) throw new Error("seminar_portal/get requires id");
    return {
      structuredContent: await request(
        credential,
        `/api/v1/seminars/${encodeURIComponent(id)}`,
        {},
        tool,
      ),
    };
  }

  if (tool === "seminar_portal/recommend") {
    const tech = techValues(args);
    if (!tech.length) {
      throw new Error(
        "seminar_portal/recommend requires tech — one or more names from seminar_portal/list_tech",
      );
    }
    return {
      structuredContent: await request(
        credential,
        "/api/v1/recommend",
        { tech, limit: optionalArg(args, "limit") },
        tool,
      ),
    };
  }

  throw new Error(`Unknown Seminar Portal tool: ${tool}`);
}
