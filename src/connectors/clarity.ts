// Microsoft Clarity connector — Data Export API tokens.
const CLARITY_API = "https://www.clarity.ms";
const CLARITY_TIMEOUT_MS = 10_000;

type ClarityArgs = Record<string, unknown>;

const VALID_DIMENSIONS = new Set(["Browser", "Device", "Country", "OS", "Source", "Medium", "Campaign", "Channel", "URL"]);

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
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

async function fetchClarity(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLARITY_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[clarity] request", { path, ...logContext });
    const response = await fetch(`${CLARITY_API}${path}`, { ...init, signal: controller.signal });
    console.log("[clarity] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[clarity] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${CLARITY_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Microsoft Clarity request timed out after ${CLARITY_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function numOfDays(value: unknown) {
  const n = Number(value ?? 1);
  if (!Number.isFinite(n) || ![1, 2, 3].includes(Math.floor(n))) {
    throw new Error("num_of_days must be 1, 2, or 3");
  }
  return Math.floor(n);
}

function normalizeDimension(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const matched = Array.from(VALID_DIMENSIONS).find((d) => d.toLowerCase() === raw.toLowerCase());
  if (!matched) throw new Error(`invalid dimension: ${raw}. Valid dimensions: ${Array.from(VALID_DIMENSIONS).join(", ")}`);
  return matched;
}

export async function callClarityTool(tool: string, args: ClarityArgs, token: string) {
  if (tool === "clarity/list_projects") {
    const r = await fetchClarity("/projects", { headers: headers(token) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Microsoft Clarity list_projects failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { results: Array.isArray(j) ? j : (j.projects ?? j.result ?? j) } };
  }

  if (tool === "clarity/get_live_insights") {
    const params = new URLSearchParams();
    params.set("numOfDays", String(numOfDays(args.num_of_days ?? args.numOfDays ?? args.number_of_days)));

    const dimensions = Array.isArray(args.dimensions)
      ? args.dimensions.map(normalizeDimension).filter(Boolean).slice(0, 3)
      : [
          normalizeDimension(args.dimension1 ?? args.dimension_1),
          normalizeDimension(args.dimension2 ?? args.dimension_2),
          normalizeDimension(args.dimension3 ?? args.dimension_3),
        ].filter(Boolean);
    dimensions.slice(0, 3).forEach((dimension, index) => {
      params.set(`dimension${index + 1}`, dimension);
    });

    const r = await fetchClarity(`/export-data/api/v1/project-live-insights?${params.toString()}`, {
      headers: headers(token),
    }, { tool, numOfDays: params.get("numOfDays"), dimensions });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Microsoft Clarity get_live_insights failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return {
      structuredContent: {
        num_of_days: Number(params.get("numOfDays")),
        dimensions,
        results: j,
      },
    };
  }

  throw new Error(`Unknown Microsoft Clarity tool: ${tool}`);
}
