// intent-engine connector — API token via Authorization: Bearer.
//
// A Japanese corporate intent-signal warehouse (ClickHouse). It stores facts —
// "which company did what, when" — from subsidy adoption lists and from the
// Japan Pension Service's list of social-insurance-covered establishments.
//
// The second source is what makes it worth querying: the number of insured
// employees per company, monthly. Subsidies say "already bought"; a shrinking
// headcount says "in trouble right now". The two answer different questions,
// so a caller usually wants both, which is why /api/companies/:key returns the
// signals and the headcount history in one response.
//
// The base URL is part of the credential: this is a self-hosted service, so a
// workspace points its connection at its own deployment.
const DEFAULT_BASE = "https://intent-engine-production-f43a.up.railway.app";
const INTENT_TIMEOUT_MS = 20_000;

type IntentArgs = Record<string, unknown>;

type Credential = { apiToken: string; baseUrl: string };

/**
 * The credential is either a bare API token or JSON carrying a base URL too.
 * Bare tokens keep the common case a paste; the JSON form is how a second
 * deployment gets pointed somewhere else.
 */
function parseCredential(credential: string): Credential {
  const raw = credential.trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const apiToken = String(
        parsed.api_token ?? parsed.apiToken ?? parsed.api_key ?? parsed.token ?? "",
      ).trim();
      const baseUrl = String(parsed.base_url ?? parsed.baseUrl ?? "").trim();
      return { apiToken, baseUrl: (baseUrl || DEFAULT_BASE).replace(/\/+$/, "") };
    }
  } catch {
    // plain API token
  }
  return { apiToken: raw, baseUrl: DEFAULT_BASE };
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

function optionalArg(args: IntentArgs, key: string, aliases: string[] = []): string | undefined {
  for (const k of [key, ...aliases]) {
    const v = args?.[k];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

async function request(
  credential: string,
  path: string,
  params: Record<string, string | undefined>,
  tool: string,
) {
  const { apiToken, baseUrl } = parseCredential(credential);
  if (!apiToken) throw new Error("intent-engine credential must include an api_token");

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[intent_engine] request", { tool, path });
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
      signal: controller.signal,
    });
    console.log("[intent_engine] response", {
      tool,
      status: response.status,
      durationMs: Date.now() - started,
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      const detail = typeof body === "object" ? JSON.stringify(body).slice(0, 300) : String(body);
      throw new Error(`intent-engine ${response.status} for ${path}: ${detail}`);
    }
    return body;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[intent_engine] failed", {
      tool,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${INTENT_TIMEOUT_MS}ms` : String(e?.message ?? e),
    });
    if (aborted) throw new Error(`intent-engine request timed out after ${INTENT_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callIntentEngineTool(tool: string, args: IntentArgs, credential: string) {
  if (tool === "intent_engine/health") {
    return { structuredContent: await request(credential, "/api/health", {}, tool) };
  }

  if (tool === "intent_engine/list_signal_types") {
    return {
      structuredContent: { signal_types: await request(credential, "/api/signal-types", {}, tool) },
    };
  }

  if (tool === "intent_engine/search_signals") {
    return {
      structuredContent: await request(
        credential,
        "/api/signals",
        {
          q: optionalArg(args, "q", ["keyword", "query"]),
          semantic: optionalArg(args, "semantic"),
          // The API accepts the Japanese label as well as the raw signal_type.
          type: optionalArg(args, "type", ["signal_type"]),
          pref: optionalArg(args, "pref", ["prefecture"]),
          tag: optionalArg(args, "tag"),
          minStrength: optionalArg(args, "min_strength", ["minStrength"]),
          expired: optionalArg(args, "include_expired", ["expired"]),
          limit: optionalArg(args, "limit"),
          offset: optionalArg(args, "offset"),
        },
        tool,
      ),
    };
  }

  if (tool === "intent_engine/get_company") {
    const key = optionalArg(args, "key", ["corporate_number", "company_key", "domain"]);
    if (!key) {
      throw new Error(
        "intent_engine/get_company requires key — a 13-digit corporate number, jcn:..., or a domain",
      );
    }
    return {
      structuredContent: await request(
        credential,
        `/api/companies/${encodeURIComponent(key)}`,
        {},
        tool,
      ),
    };
  }

  if (tool === "intent_engine/stacked_companies") {
    return {
      structuredContent: {
        companies: await request(
          credential,
          "/api/stack",
          { min: optionalArg(args, "min"), limit: optionalArg(args, "limit") },
          tool,
        ),
      },
    };
  }

  if (tool === "intent_engine/headcount_changes") {
    return {
      structuredContent: {
        changes: await request(
          credential,
          "/api/headcount/changes",
          {
            direction: optionalArg(args, "direction"),
            minDiff: optionalArg(args, "min_diff", ["minDiff"]),
            pref: optionalArg(args, "pref", ["prefecture"]),
            limit: optionalArg(args, "limit"),
          },
          tool,
        ),
      },
    };
  }

  if (tool === "intent_engine/insured_summary") {
    return { structuredContent: await request(credential, "/api/insured/summary", {}, tool) };
  }

  throw new Error(`Unknown intent-engine tool: ${tool}`);
}
