// Google Sheets connector - OAuth access token via Authorization: Bearer.
// Targets the Google Sheets API v4.
const GSHEETS_API = "https://sheets.googleapis.com/v4";
const GSHEETS_TIMEOUT_MS = 12_000;

type GSheetsArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(accessToken: string, json = false) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchGSheets(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GSHEETS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_sheets] request", { path, ...logContext });
    const response = await fetch(`${GSHEETS_API}${path}`, { ...init, signal: controller.signal });
    console.log("[google_sheets] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_sheets] failed", { path, durationMs: Date.now() - started, error: aborted ? `timeout after ${GSHEETS_TIMEOUT_MS}ms` : String(e?.message ?? e), ...logContext });
    if (aborted) throw new Error(`Google Sheets request timed out after ${GSHEETS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: GSheetsArgs, snake: string, aliases: string[] = []) {
  const candidates = [snake, snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...aliases];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

async function request(accessToken: string, method: string, path: string, body: unknown, tool: string, logContext: Record<string, unknown> = {}) {
  const init: RequestInit = { method, headers: headers(accessToken, body !== undefined) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchGSheets(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Google Sheets ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

function valuesArg(args: GSheetsArgs) {
  const values = args.values;
  if (!Array.isArray(values)) throw new Error("values (array of row arrays) is required");
  return values;
}

export async function callGoogleSheetsTool(tool: string, args: GSheetsArgs, accessToken: string) {
  if (tool === "google_sheets/get_spreadsheet") {
    const spreadsheetId = idArg(args, "spreadsheet_id", ["spreadsheetId"]);
    const params = new URLSearchParams();
    if (args.include_grid_data ?? args.includeGridData) params.set("includeGridData", "true");
    for (const r of ([] as string[]).concat((args.ranges as any) ?? [])) params.append("ranges", String(r));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return { structuredContent: await request(accessToken, "GET", `/spreadsheets/${encodeURIComponent(spreadsheetId)}${qs}`, undefined, tool, { spreadsheetId }) };
  }

  if (tool === "google_sheets/get_values") {
    const spreadsheetId = idArg(args, "spreadsheet_id", ["spreadsheetId"]);
    const range = idArg(args, "range");
    return { structuredContent: await request(accessToken, "GET", `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`, undefined, tool, { spreadsheetId, range }) };
  }

  if (tool === "google_sheets/batch_get_values") {
    const spreadsheetId = idArg(args, "spreadsheet_id", ["spreadsheetId"]);
    const ranges = ([] as string[]).concat((args.ranges as any) ?? []);
    if (!ranges.length) throw new Error("ranges (array) is required");
    const params = new URLSearchParams();
    for (const r of ranges) params.append("ranges", String(r));
    return { structuredContent: await request(accessToken, "GET", `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params.toString()}`, undefined, tool, { spreadsheetId }) };
  }

  if (tool === "google_sheets/update_values") {
    const spreadsheetId = idArg(args, "spreadsheet_id", ["spreadsheetId"]);
    const range = idArg(args, "range");
    const valueInputOption = String(args.value_input_option ?? args.valueInputOption ?? "USER_ENTERED");
    return { structuredContent: await request(accessToken, "PUT", `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=${encodeURIComponent(valueInputOption)}`, { range, values: valuesArg(args) }, tool, { spreadsheetId, range }) };
  }

  if (tool === "google_sheets/append_values") {
    const spreadsheetId = idArg(args, "spreadsheet_id", ["spreadsheetId"]);
    const range = idArg(args, "range");
    const valueInputOption = String(args.value_input_option ?? args.valueInputOption ?? "USER_ENTERED");
    return { structuredContent: await request(accessToken, "POST", `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=${encodeURIComponent(valueInputOption)}`, { range, values: valuesArg(args) }, tool, { spreadsheetId, range }) };
  }

  if (tool === "google_sheets/create_spreadsheet") {
    const title = idArg(args, "title");
    return { structuredContent: await request(accessToken, "POST", "/spreadsheets", { properties: { title } }, tool) };
  }

  throw new Error(`Unknown Google Sheets tool: ${tool}`);
}
