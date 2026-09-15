// DataForSEO connector - HTTP Basic auth with the account login (email) as
// username and the API password as password, both from
// https://app.dataforseo.com/api-access. REST API v3
// (https://api.dataforseo.com/v3). Covers SERP, keyword data, DataForSEO Labs,
// backlinks, and OnPage instant checks.
//
// Every v3 POST endpoint takes an ARRAY of tasks and answers with an envelope:
//   { status_code, cost, tasks: [{ status_code, result: [...] }] }
// Both the envelope and the task carry their own status; 20000 means OK. Live
// results are large (a SERP can be hundreds of KB), so each tool returns a
// trimmed projection plus the cost of the call.
// Docs: https://docs.dataforseo.com/v3/
const DATAFORSEO_API = "https://api.dataforseo.com";
// Live endpoints run the query in real time; SERP and OnPage can take ~30s.
const DATAFORSEO_TIMEOUT_MS = 90_000;
const OK_STATUS = 20000;
/** Japan / Japanese, used when a call needs targeting and none was given. */
const DEFAULT_LOCATION_CODE = 2392;
const DEFAULT_LANGUAGE_CODE = "ja";
const MAX_ITEMS = 200;

type DataForSeoArgs = Record<string, unknown>;

function parseCredential(credential: string) {
  let login = "";
  let password = "";
  try {
    const parsed = JSON.parse(credential);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      login = String(parsed.login ?? parsed.email ?? parsed.username ?? "").trim();
      password = String(parsed.password ?? parsed.api_password ?? parsed.apiPassword ?? "").trim();
    }
  } catch {
    // plain "login:password" credential
    const raw = credential.trim();
    const sep = raw.indexOf(":");
    if (sep > 0) {
      login = raw.slice(0, sep).trim();
      password = raw.slice(sep + 1).trim();
    }
  }
  if (!login || !password) {
    throw new Error('DataForSEO credential requires {"login","password"} (the API login email and API password from app.dataforseo.com/api-access)');
  }
  return { login, password };
}

function authHeader(credential: string) {
  const { login, password } = parseCredential(credential);
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
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

async function fetchDataForSeo(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DATAFORSEO_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[dataforseo] request", { path, ...logContext });
    const response = await fetch(`${DATAFORSEO_API}${path}`, { ...init, signal: controller.signal });
    console.log("[dataforseo] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[dataforseo] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${DATAFORSEO_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`DataForSEO request timed out after ${DATAFORSEO_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

async function request(credential: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    Authorization: authHeader(credential),
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetchDataForSeo(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`DataForSEO ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  if (j?.status_code !== undefined && j.status_code !== OK_STATUS) {
    throw new Error(`DataForSEO ${tool} failed: ${j.status_code} ${j.status_message ?? ""}`.trim());
  }
  return j;
}

/** POST a single live task and unwrap tasks[0].result, surfacing task-level errors. */
async function postTask(credential: string, path: string, task: Record<string, unknown>, tool: string, logContext: Record<string, unknown> = {}) {
  const envelope: any = await request(credential, "POST", path, [task], tool, logContext);
  const first = Array.isArray(envelope?.tasks) ? envelope.tasks[0] : undefined;
  if (!first) throw new Error(`DataForSEO ${tool} returned no task`);
  if (first.status_code !== OK_STATUS) {
    throw new Error(`DataForSEO ${tool} task failed: ${first.status_code} ${first.status_message ?? ""}`.trim());
  }
  return { result: Array.isArray(first.result) ? first.result : [], cost: envelope.cost ?? 0, task };
}

function str(value: unknown) {
  return String(value ?? "").trim();
}

function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function requireArg(args: DataForSeoArgs, key: string, aliases: string[] = []) {
  for (const candidate of [key, ...aliases]) {
    const value = str(args[candidate]);
    if (value) return value;
  }
  throw new Error(`${key} is required`);
}

function keywordList(args: DataForSeoArgs, max: number) {
  const raw = args.keywords ?? args.keyword;
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/\r?\n|,/);
  const keywords = list.map((k) => str(k)).filter(Boolean).slice(0, max);
  if (!keywords.length) throw new Error("keywords is required");
  return keywords;
}

/**
 * DataForSEO answers 40501 "Invalid Field: 'location_code'/'language_code'" when a
 * targeting value is not in the list for the calling API family. serp, keywords_data
 * and DataForSEO Labs each publish their own list, and Labs restricts languages per
 * location (available_languages), so e.g. "ja" is rejected for the United States on
 * Labs. The lists are free of charge, cached for 24h and shared between concurrent
 * calls. When a list cannot be fetched the task is sent unvalidated (fail open), so
 * validation never blocks a call that would have succeeded.
 */
const TARGETING_LIST_TTL_MS = 24 * 60 * 60 * 1000;
const TARGETING_LIST_RETRY_MS = 5 * 60 * 1000;
const TARGETING_LIST_TIMEOUT_MS = 10_000;

interface TargetingList {
  locations: Set<number>;
  languages: Map<string, string>; // lowercase code -> code as DataForSEO writes it
  locationLanguages?: Map<number, Set<string>>; // Labs only: location_code -> available language codes
  locationNames?: Map<string, number>; // Labs only: lowercase country name -> location_code
}

const targetingListCache = new Map<string, { list: TargetingList; at: number }>();
const targetingListInflight = new Map<string, Promise<TargetingList | null>>();
const targetingListFailedAt = new Map<string, number>();

export function resetTargetingListCacheForTests() {
  targetingListCache.clear();
  targetingListInflight.clear();
  targetingListFailedAt.clear();
}

function targetingFamily(tool: string): "serp" | "keywords_data" | "labs" {
  if (tool === "dataforseo/serp_google_organic") return "serp";
  if (tool === "dataforseo/keyword_search_volume") return "keywords_data";
  return "labs";
}

function targetingFamilyLabel(family: "serp" | "keywords_data" | "labs") {
  if (family === "serp") return "Google SERP";
  if (family === "keywords_data") return "Google Ads (Keywords Data)";
  return "DataForSEO Labs";
}

function raceTimeout<T>(p: Promise<T>, ms: number, what: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then((value) => { clearTimeout(timer); resolve(value); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

async function loadTargetingList(credential: string, family: "serp" | "keywords_data" | "labs", tool: string): Promise<TargetingList | null> {
  const cached = targetingListCache.get(family);
  if (cached && Date.now() - cached.at < TARGETING_LIST_TTL_MS) return cached.list;
  if (Date.now() - (targetingListFailedAt.get(family) ?? 0) < TARGETING_LIST_RETRY_MS) return null;
  let inflight = targetingListInflight.get(family);
  if (!inflight) {
    inflight = (async () => {
      try {
        let list: TargetingList;
        if (family === "labs") {
          const env: any = await raceTimeout(request(credential, "GET", "/v3/dataforseo_labs/locations_and_languages", undefined, tool), TARGETING_LIST_TIMEOUT_MS, "DataForSEO Labs locations_and_languages");
          const locations = new Set<number>();
          const locationLanguages = new Map<number, Set<string>>();
          const locationNames = new Map<string, number>();
          const languages = new Map<string, string>();
          for (const row of env?.tasks?.[0]?.result ?? []) {
            const code = Number(row?.location_code);
            if (!Number.isFinite(code)) continue;
            locations.add(code);
            locationNames.set(str(row?.location_name).toLowerCase(), code);
            const available = new Set<string>();
            for (const l of row?.available_languages ?? []) {
              const langCode = str(l?.language_code).toLowerCase();
              if (!langCode) continue;
              available.add(langCode);
              languages.set(langCode, str(l?.language_code));
            }
            locationLanguages.set(code, available);
          }
          if (!locations.size || !languages.size) throw new Error("DataForSEO Labs locations_and_languages came back empty");
          list = { locations, languages, locationLanguages, locationNames };
        } else {
          const locationsPath = family === "serp" ? "/v3/serp/google/locations" : "/v3/keywords_data/google_ads/locations";
          const languagesPath = family === "serp" ? "/v3/serp/google/languages" : "/v3/keywords_data/google_ads/languages";
          const [locEnv, langEnv]: any[] = await raceTimeout(Promise.all([
            request(credential, "GET", locationsPath, undefined, tool),
            request(credential, "GET", languagesPath, undefined, tool),
          ]), TARGETING_LIST_TIMEOUT_MS, "DataForSEO locations/languages lists");
          const locations = new Set<number>();
          for (const row of locEnv?.tasks?.[0]?.result ?? []) {
            const code = Number(row?.location_code);
            if (Number.isFinite(code)) locations.add(code);
          }
          const languages = new Map<string, string>();
          for (const row of langEnv?.tasks?.[0]?.result ?? []) {
            const langCode = str(row?.language_code).toLowerCase();
            if (langCode) languages.set(langCode, str(row?.language_code));
          }
          if (!locations.size || !languages.size) throw new Error("DataForSEO locations/languages list came back empty");
          list = { locations, languages };
        }
        targetingListCache.set(family, { list, at: Date.now() });
        targetingListFailedAt.delete(family);
        return list;
      } catch (e: any) {
        console.error("[dataforseo] targeting list unavailable, sending task unvalidated", { family, error: String(e?.message ?? e) });
        targetingListFailedAt.set(family, Date.now());
        return null;
      } finally {
        targetingListInflight.delete(family);
      }
    })();
    targetingListInflight.set(family, inflight);
  }
  return inflight;
}

/**
 * Location/language for a task. `required` endpoints (DataForSEO Labs, keyword
 * ideas) reject a task without targeting, so fall back to Japan/Japanese there
 * rather than failing the call.
 *
 * Codes the calling API family does not list are rejected here with the reason and
 * the alternative to use instead (DataForSEO answers 40501 Invalid Field for them,
 * and the audit check counts upstream 40501 rows by substring, so the rejection
 * message must not contain that code). Labs only lists country locations and
 * restricts languages per location, so when the location does not list Japanese the
 * default language is omitted instead of sent (omitting it means all languages).
 */
async function targeting(tool: string, args: DataForSeoArgs, credential: string, required = false) {
  const family = targetingFamily(tool);
  const out: Record<string, unknown> = {};
  const locationCode = num(args.location_code);
  const locationName = str(args.location_name);
  const languageCode = str(args.language_code);
  const languageName = str(args.language_name);
  const list = locationCode || languageCode || (required && family === "labs")
    ? await loadTargetingList(credential, family, tool)
    : null;
  const nameLocation = family === "labs" && locationName ? list?.locationNames?.get(locationName.toLowerCase()) : undefined;
  const effectiveLocation = locationCode || nameLocation || (required && !locationName ? DEFAULT_LOCATION_CODE : 0);

  if (locationCode) {
    if (list && !list.locations.has(locationCode)) {
      throw new Error(`location_code ${locationCode} is not in DataForSEO's ${targetingFamilyLabel(family)} locations list. Use location_name (e.g. "Japan") instead, or pick a valid location_code with the dataforseo/list_locations tool.`);
    }
    out.location_code = locationCode;
  } else if (locationName) {
    out.location_name = locationName;
  } else if (required) {
    out.location_code = DEFAULT_LOCATION_CODE;
  }

  if (languageCode) {
    if (family === "labs" && list) {
      const available = effectiveLocation ? list.locationLanguages?.get(effectiveLocation) : undefined;
      const known = available ?? new Set([...list.languages.keys()]);
      if (!known.has(languageCode.toLowerCase())) {
        if (available) {
          const examples = [...available].sort().slice(0, 5).join(", ");
          throw new Error(`language_code "${languageCode}" is not available for location_code ${effectiveLocation} in DataForSEO Labs (available: ${examples}). Use one of the available languages for this location, drop language_code for all available languages, or keep the default location 2392 (Japan) for "ja".`);
        }
        throw new Error(`language_code "${languageCode}" is not in DataForSEO Labs' language list. Use language_name (e.g. "Japanese") or a listed language_code such as "ja" or "en".`);
      }
    } else if (list) {
      const canonical = list.languages.get(languageCode.toLowerCase());
      if (!canonical) {
        throw new Error(`language_code "${languageCode}" is not in DataForSEO's ${targetingFamilyLabel(family)} languages list. Use language_name (e.g. "Japanese") or a listed language_code such as "ja" or "en".`);
      }
      out.language_code = canonical;
    }
    if (!out.language_code) out.language_code = languageCode;
  } else if (languageName) {
    out.language_name = languageName;
  } else if (required) {
    const available = family === "labs" && effectiveLocation ? list?.locationLanguages?.get(effectiveLocation) : undefined;
    if (!available || available.has(DEFAULT_LANGUAGE_CODE)) {
      out.language_code = DEFAULT_LANGUAGE_CODE;
    }
  }
  return out;
}

/** limit/offset/filters/order_by, shared by the Labs and Backlinks endpoints. */
function paging(args: DataForSeoArgs, defaultLimit = 100) {
  const out: Record<string, unknown> = { limit: Math.min(num(args.limit) || defaultLimit, 1000) };
  const offset = num(args.offset);
  if (offset) out.offset = offset;
  if (Array.isArray(args.filters) && args.filters.length) out.filters = args.filters;
  if (Array.isArray(args.order_by) && args.order_by.length) out.order_by = args.order_by;
  return out;
}

function pick<T extends Record<string, any>>(source: T | undefined | null, keys: string[]) {
  const out: Record<string, any> = {};
  if (!source || typeof source !== "object") return out;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key];
  }
  return out;
}

function items(result: any[], key = "items"): any[] {
  const first = result[0];
  const list = first?.[key];
  return Array.isArray(list) ? list.slice(0, MAX_ITEMS) : [];
}

function slimSerpItem(item: any) {
  const base = pick(item, ["type", "rank_group", "rank_absolute", "position", "domain", "title", "url", "breadcrumb", "description", "is_featured_snippet", "is_image", "is_video"]);
  // Container items (people_also_ask, top_stories, ...) carry nested arrays we
  // do not want to inline; keep a count instead.
  if (Array.isArray(item?.items)) base.nested_items_count = item.items.length;
  return base;
}

function slimKeywordInfo(info: any) {
  return pick(info, ["search_volume", "cpc", "competition", "competition_level", "low_top_of_page_bid", "high_top_of_page_bid"]);
}

export async function callDataForSeoTool(tool: string, args: DataForSeoArgs, credential: string) {
  if (tool === "dataforseo/get_user_data") {
    const envelope: any = await request(credential, "GET", "/v3/appendix/user_data", undefined, tool);
    const result = envelope?.tasks?.[0]?.result?.[0] ?? {};
    return {
      structuredContent: {
        login: result.login,
        timezone: result.timezone,
        money: pick(result.money, ["total", "balance", "limits"]),
        rates: pick(result.rates, ["limits"]),
        backlinks_subscription_expiry_date: result.backlinks_subscription_expiry_date ?? null,
      },
    };
  }

  if (tool === "dataforseo/list_locations") {
    const country = (str(args.country) || "JP").toLowerCase();
    const query = str(args.query).toLowerCase();
    const limit = Math.min(num(args.limit) || 50, 200);
    const envelope: any = await request(credential, "GET", `/v3/serp/google/locations/${encodeURIComponent(country)}`, undefined, tool, { country });
    const all: any[] = envelope?.tasks?.[0]?.result ?? [];
    const matched = all
      .filter((l) => !query || String(l?.location_name ?? "").toLowerCase().includes(query))
      .slice(0, limit)
      .map((l) => pick(l, ["location_code", "location_name", "location_code_parent", "country_iso_code", "location_type"]));
    return { structuredContent: { country, total_matched: all.length, locations: matched } };
  }

  if (tool === "dataforseo/serp_google_organic") {
    const task: Record<string, unknown> = {
      keyword: requireArg(args, "keyword"),
      ...(await targeting(tool, args, credential, true)),
      device: str(args.device) || "desktop",
      depth: Math.min(num(args.depth) || 20, 200),
    };
    const os = str(args.os);
    if (os) task.os = os;
    const { result, cost } = await postTask(credential, "/v3/serp/google/organic/live/advanced", task, tool, { keyword: task.keyword });
    const first = result[0] ?? {};
    return {
      structuredContent: {
        cost,
        keyword: first.keyword,
        location_code: first.location_code,
        language_code: first.language_code,
        check_url: first.check_url,
        datetime: first.datetime,
        se_results_count: first.se_results_count,
        items_count: first.items_count,
        items: items(result).map(slimSerpItem),
      },
    };
  }

  if (tool === "dataforseo/keyword_search_volume") {
    const task: Record<string, unknown> = {
      keywords: keywordList(args, 1000),
      ...(await targeting(tool, args, credential, true)),
    };
    if (args.search_partners !== undefined) task.search_partners = Boolean(args.search_partners);
    const dateFrom = str(args.date_from);
    if (dateFrom) task.date_from = dateFrom;
    const dateTo = str(args.date_to);
    if (dateTo) task.date_to = dateTo;
    const sortBy = str(args.sort_by);
    if (sortBy) task.sort_by = sortBy;
    const { result, cost } = await postTask(credential, "/v3/keywords_data/google_ads/search_volume/live", task, tool);
    const includeMonthly = Boolean(args.include_monthly);
    const keywords = result.slice(0, 1000).map((row: any) => ({
      ...pick(row, ["keyword", "search_volume", "cpc", "competition", "competition_index", "low_top_of_page_bid", "high_top_of_page_bid"]),
      ...(includeMonthly && Array.isArray(row?.monthly_searches) ? { monthly_searches: row.monthly_searches } : {}),
    }));
    return { structuredContent: { cost, keywords_count: keywords.length, keywords } };
  }

  if (tool === "dataforseo/keyword_ideas") {
    const task: Record<string, unknown> = {
      keywords: keywordList(args, 200),
      ...(await targeting(tool, args, credential, true)),
      ...paging(args, 100),
    };
    if (args.closely_variants !== undefined) task.closely_variants = Boolean(args.closely_variants);
    const { result, cost } = await postTask(credential, "/v3/dataforseo_labs/google/keyword_ideas/live", task, tool);
    const first = result[0] ?? {};
    return {
      structuredContent: {
        cost,
        total_count: first.total_count,
        items_count: first.items_count,
        items: items(result).map((item: any) => ({
          keyword: item?.keyword,
          ...slimKeywordInfo(item?.keyword_info),
          keyword_difficulty: item?.keyword_properties?.keyword_difficulty,
          main_intent: item?.search_intent_info?.main_intent,
        })),
      },
    };
  }

  if (tool === "dataforseo/ranked_keywords") {
    const task: Record<string, unknown> = {
      target: requireArg(args, "target", ["domain", "url"]),
      ...(await targeting(tool, args, credential, true)),
      ...paging(args, 100),
    };
    if (Array.isArray(args.item_types) && args.item_types.length) task.item_types = args.item_types;
    const { result, cost } = await postTask(credential, "/v3/dataforseo_labs/google/ranked_keywords/live", task, tool, { target: task.target });
    const first = result[0] ?? {};
    return {
      structuredContent: {
        cost,
        target: first.target,
        total_count: first.total_count,
        items_count: first.items_count,
        metrics: pick(first.metrics?.organic, ["count", "etv", "estimated_paid_traffic_cost", "pos_1", "pos_2_3", "pos_4_10"]),
        items: items(result).map((item: any) => {
          const serpItem = item?.ranked_serp_element?.serp_item ?? {};
          return {
            keyword: item?.keyword_data?.keyword,
            ...slimKeywordInfo(item?.keyword_data?.keyword_info),
            ...pick(serpItem, ["rank_group", "rank_absolute", "title", "url", "etv", "is_featured_snippet"]),
          };
        }),
      },
    };
  }

  if (tool === "dataforseo/domain_rank_overview") {
    const task: Record<string, unknown> = {
      target: requireArg(args, "target", ["domain"]),
      ...(await targeting(tool, args, credential, true)),
      limit: Math.min(num(args.limit) || 10, 1000),
    };
    const { result, cost } = await postTask(credential, "/v3/dataforseo_labs/google/domain_rank_overview/live", task, tool, { target: task.target });
    const first = result[0] ?? {};
    const overview = Array.isArray(first.items) ? first.items[0] : undefined;
    return {
      structuredContent: {
        cost,
        target: first.target,
        location_code: first.location_code,
        language_code: first.language_code,
        metrics: overview?.metrics ?? {},
      },
    };
  }

  if (tool === "dataforseo/competitors_domain") {
    const task: Record<string, unknown> = {
      target: requireArg(args, "target", ["domain"]),
      ...(await targeting(tool, args, credential, true)),
      ...paging(args, 20),
    };
    if (args.exclude_top_domains !== undefined) task.exclude_top_domains = Boolean(args.exclude_top_domains);
    if (num(args.max_rank_group)) task.max_rank_group = num(args.max_rank_group);
    const { result, cost } = await postTask(credential, "/v3/dataforseo_labs/google/competitors_domain/live", task, tool, { target: task.target });
    const first = result[0] ?? {};
    return {
      structuredContent: {
        cost,
        target: first.target,
        total_count: first.total_count,
        items: items(result).map((item: any) => ({
          ...pick(item, ["domain", "avg_position", "sum_position", "intersections"]),
          organic: pick(item?.metrics?.organic, ["count", "etv", "estimated_paid_traffic_cost", "pos_1", "pos_2_3", "pos_4_10"]),
        })),
      },
    };
  }

  if (tool === "dataforseo/backlinks_summary") {
    const task: Record<string, unknown> = {
      target: requireArg(args, "target", ["domain", "url"]),
      internal_list_limit: Math.min(num(args.internal_list_limit) || 10, 1000),
      backlinks_status_type: str(args.backlinks_status_type) || "live",
    };
    if (args.include_subdomains !== undefined) task.include_subdomains = Boolean(args.include_subdomains);
    const { result, cost } = await postTask(credential, "/v3/backlinks/summary/live", task, tool, { target: task.target });
    const first = result[0] ?? {};
    return {
      structuredContent: {
        cost,
        ...pick(first, [
          "target",
          "first_seen",
          "lost_date",
          "rank",
          "backlinks",
          "backlinks_spam_score",
          "broken_backlinks",
          "broken_pages",
          "referring_domains",
          "referring_domains_nofollow",
          "referring_main_domains",
          "referring_ips",
          "referring_pages",
          "internal_links_count",
          "external_links_count",
          "referring_links_types",
          "referring_links_attributes",
          "referring_links_platform_types",
          "referring_links_tld",
          "referring_links_countries",
        ]),
      },
    };
  }

  if (tool === "dataforseo/backlinks_list") {
    const task: Record<string, unknown> = {
      target: requireArg(args, "target", ["domain", "url"]),
      ...paging(args, 100),
      mode: str(args.mode) || "one_per_domain",
      backlinks_status_type: str(args.backlinks_status_type) || "live",
    };
    if (args.include_subdomains !== undefined) task.include_subdomains = Boolean(args.include_subdomains);
    const { result, cost } = await postTask(credential, "/v3/backlinks/backlinks/live", task, tool, { target: task.target });
    const first = result[0] ?? {};
    return {
      structuredContent: {
        cost,
        target: first.target,
        total_count: first.total_count,
        items_count: first.items_count,
        items: items(result).map((item: any) => pick(item, [
          "domain_from",
          "url_from",
          "url_to",
          "anchor",
          "dofollow",
          "item_type",
          "rank",
          "domain_from_rank",
          "page_from_language",
          "first_seen",
          "last_seen",
          "is_new",
          "is_lost",
        ])),
      },
    };
  }

  if (tool === "dataforseo/referring_domains") {
    const task: Record<string, unknown> = {
      target: requireArg(args, "target", ["domain", "url"]),
      ...paging(args, 100),
      backlinks_status_type: str(args.backlinks_status_type) || "live",
    };
    if (args.include_subdomains !== undefined) task.include_subdomains = Boolean(args.include_subdomains);
    const { result, cost } = await postTask(credential, "/v3/backlinks/referring_domains/live", task, tool, { target: task.target });
    const first = result[0] ?? {};
    return {
      structuredContent: {
        cost,
        target: first.target,
        total_count: first.total_count,
        items_count: first.items_count,
        items: items(result).map((item: any) => pick(item, [
          "domain",
          "rank",
          "backlinks",
          "backlinks_spam_score",
          "broken_backlinks",
          "referring_domains",
          "referring_pages",
          "first_seen",
          "lost_date",
        ])),
      },
    };
  }

  if (tool === "dataforseo/on_page_instant") {
    const task: Record<string, unknown> = { url: requireArg(args, "url") };
    if (args.enable_javascript !== undefined) task.enable_javascript = Boolean(args.enable_javascript);
    const browserPreset = str(args.browser_preset);
    if (browserPreset) {
      // DataForSEO requires JavaScript rendering for browser presets and rejects the
      // task with 40501 Invalid Field otherwise (observed in production).
      task.browser_preset = browserPreset;
      task.enable_javascript = true;
    }
    const customUserAgent = str(args.custom_user_agent);
    if (customUserAgent) task.custom_user_agent = customUserAgent;
    const { result, cost } = await postTask(credential, "/v3/on_page/instant_pages", task, tool, { url: task.url });
    const page = items(result)[0] ?? {};
    const meta = page.meta ?? {};
    return {
      structuredContent: {
        cost,
        ...pick(page, ["url", "status_code", "location", "onpage_score", "total_dom_size", "fetch_time", "media_type", "size", "encoded_size"]),
        page_timing: pick(page.page_timing, ["time_to_interactive", "dom_complete", "largest_contentful_paint", "first_input_delay", "connection_time", "waiting_time"]),
        meta: {
          ...pick(meta, ["title", "description", "canonical", "charset", "follow", "generator", "internal_links_count", "external_links_count", "images_count", "title_length", "description_length"]),
          htags: pick(meta.htags, ["h1", "h2", "h3"]),
          content: pick(meta.content, ["plain_text_size", "plain_text_word_count", "automated_readability_index", "text_to_html_ratio"]),
        },
        // Checks are ~40 booleans with mixed polarity (`no_h1_tag: true` is a
        // problem, `is_https: true` is not), so pass them through verbatim.
        checks: page.checks ?? {},
      },
    };
  }

  throw new Error(`Unknown DataForSEO tool: ${tool}`);
}
