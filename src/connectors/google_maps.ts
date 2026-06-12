// Google Maps Platform connector — API key authentication via the `key` query parameter.
// Uses the public Maps web service endpoints (Geocoding, Places, Directions,
// Distance Matrix), all of which accept the API key as a query-string parameter.
const GOOGLE_MAPS_API = "https://maps.googleapis.com";
const GOOGLE_MAPS_TIMEOUT_MS = 12_000;

type GoogleMapsArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchGoogleMaps(path: string, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_MAPS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_maps] request", { path: path.split("?")[0], ...logContext });
    const response = await fetch(`${GOOGLE_MAPS_API}${path}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    console.log("[google_maps] response", { path: path.split("?")[0], status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_maps] failed", {
      path: path.split("?")[0],
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${GOOGLE_MAPS_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Google Maps request timed out after ${GOOGLE_MAPS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function str(value: unknown) {
  return String(value ?? "").trim();
}

function requireArg(args: GoogleMapsArgs, key: string, aliases: string[] = []) {
  for (const candidate of [key, ...aliases]) {
    const value = str(args[candidate]);
    if (value) return value;
  }
  throw new Error(`${key} is required`);
}

/** lat,lng — accepts a "lat,lng" string, separate lat/lng args, or {lat, lng}. */
function latLng(args: GoogleMapsArgs): string {
  const direct = str(args.latlng ?? args.lat_lng ?? args.location);
  if (direct) return direct;
  const lat = args.lat ?? args.latitude;
  const lng = args.lng ?? args.lon ?? args.longitude;
  if (lat !== undefined && lat !== "" && lng !== undefined && lng !== "") {
    return `${str(lat)},${str(lng)}`;
  }
  throw new Error("latlng is required (e.g. \"35.6895,139.6917\" or lat/lng args)");
}

/** Build a query string, skipping empty values, always appending the API key. */
function buildQuery(apiKey: string, params: Record<string, unknown>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, Array.isArray(v) ? v.join("|") : String(v));
  }
  qs.set("key", apiKey);
  return qs.toString();
}

async function request(apiKey: string, path: string, params: Record<string, unknown>, tool: string) {
  const r = await fetchGoogleMaps(`${path}?${buildQuery(apiKey, params)}`, { tool });
  const j: any = await readJsonResponse(r);
  if (!r.ok) {
    throw new Error(`Google Maps ${tool} failed: HTTP ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  }
  // Maps web services return 200 with a status field; surface non-OK statuses as errors.
  const status = j?.status;
  if (status && status !== "OK" && status !== "ZERO_RESULTS") {
    const detail = j?.error_message ? `: ${j.error_message}` : "";
    throw new Error(`Google Maps ${tool} returned ${status}${detail}`);
  }
  return j;
}

export async function callGoogleMapsTool(tool: string, args: GoogleMapsArgs, apiKey: string) {
  if (tool === "google_maps/geocode") {
    const j = await request(apiKey, "/maps/api/geocode/json", {
      address: requireArg(args, "address"),
      components: args.components,
      bounds: args.bounds,
      region: args.region,
      language: args.language,
    }, tool);
    return { structuredContent: j };
  }

  if (tool === "google_maps/reverse_geocode") {
    const j = await request(apiKey, "/maps/api/geocode/json", {
      latlng: latLng(args),
      result_type: args.result_type,
      location_type: args.location_type,
      language: args.language,
    }, tool);
    return { structuredContent: j };
  }

  if (tool === "google_maps/place_search") {
    const j = await request(apiKey, "/maps/api/place/textsearch/json", {
      query: requireArg(args, "query"),
      location: args.location,
      radius: args.radius,
      type: args.type,
      language: args.language,
      region: args.region,
      opennow: args.open_now ?? args.opennow,
      pagetoken: args.page_token ?? args.pagetoken,
    }, tool);
    return { structuredContent: j };
  }

  if (tool === "google_maps/place_details") {
    const j = await request(apiKey, "/maps/api/place/details/json", {
      place_id: requireArg(args, "place_id", ["placeId", "id"]),
      fields: args.fields,
      language: args.language,
      region: args.region,
    }, tool);
    return { structuredContent: j };
  }

  if (tool === "google_maps/directions") {
    const j = await request(apiKey, "/maps/api/directions/json", {
      origin: requireArg(args, "origin"),
      destination: requireArg(args, "destination"),
      mode: args.mode,
      waypoints: args.waypoints,
      alternatives: args.alternatives,
      avoid: args.avoid,
      departure_time: args.departure_time,
      arrival_time: args.arrival_time,
      language: args.language,
      region: args.region,
      units: args.units,
    }, tool);
    return { structuredContent: j };
  }

  if (tool === "google_maps/distance_matrix") {
    const j = await request(apiKey, "/maps/api/distancematrix/json", {
      origins: requireArg(args, "origins"),
      destinations: requireArg(args, "destinations"),
      mode: args.mode,
      avoid: args.avoid,
      departure_time: args.departure_time,
      arrival_time: args.arrival_time,
      language: args.language,
      region: args.region,
      units: args.units,
    }, tool);
    return { structuredContent: j };
  }

  throw new Error(`Unknown Google Maps tool: ${tool}`);
}
