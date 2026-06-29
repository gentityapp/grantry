// OpenAI connector - API key authentication via Authorization: Bearer <key>.
// Targets the OpenAI REST API v1. The headline tool is image generation
// (POST /images/generations). Generic read-only calls go through openai/request.
//
// Credential: paste an OpenAI API key (sk-... or sk-proj-...), or JSON
//   {"api_key":"sk-...","organization":"org_...","project":"proj_..."}
// to pin a specific org/project (optional — most keys work with the key alone).
const OPENAI_API = "https://api.openai.com/v1";
const OPENAI_TIMEOUT_MS = 60_000; // image generation can take tens of seconds

type OpenAIArgs = Record<string, unknown>;

type OpenAICredential = {
  apiKey: string;
  organization?: string;
  project?: string;
};

function parseCredential(raw: string): OpenAICredential {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.startsWith("{")) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('OpenAI credential JSON is invalid; expected {"api_key":"sk-..."}');
    }
    const apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
    if (!apiKey) throw new Error("OpenAI credential JSON must include api_key");
    return {
      apiKey,
      organization: parsed.organization ?? parsed.org ?? parsed.organization_id ?? undefined,
      project: parsed.project ?? parsed.project_id ?? undefined,
    };
  }
  if (!trimmed) throw new Error("OpenAI API key is required");
  return { apiKey: trimmed };
}

function headers(credential: OpenAICredential): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${credential.apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (credential.organization) h["OpenAI-Organization"] = String(credential.organization);
  if (credential.project) h["OpenAI-Project"] = String(credential.project);
  return h;
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

async function request(
  credential: OpenAICredential,
  method: string,
  path: string,
  body: unknown,
  tool: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[openai] request", { path, tool });
    const init: RequestInit = { method, headers: headers(credential), signal: controller.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`${OPENAI_API}${path}`, init);
    console.log("[openai] response", { path, tool, status: r.status, durationMs: Date.now() - started });
    const j: any = await readJsonResponse(r);
    if (!r.ok) {
      const message = j?.error?.message ?? j?.error ?? JSON.stringify(j).slice(0, 1000);
      throw new Error(`OpenAI ${tool} failed: ${r.status} ${typeof message === "string" ? message : JSON.stringify(message)}`);
    }
    return j;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function buildImageBody(args: OpenAIArgs): Record<string, unknown> {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt is required");
  // Default to dall-e-3 because it returns a hosted URL (small, agent-friendly
  // result). gpt-image-1 is the newer/higher-quality model but only returns
  // base64 and needs OpenAI org verification — opt in by passing model explicitly.
  const model = String(args.model ?? "dall-e-3").trim() || "dall-e-3";

  const body: Record<string, unknown> = { model, prompt };

  const size = args.size ? String(args.size).trim() : undefined;
  if (size) body.size = size;
  if (args.quality) body.quality = String(args.quality).trim();
  if (args.n !== undefined && args.n !== null && args.n !== "") body.n = Number(args.n);
  if (args.user) body.user = String(args.user);

  // response_format (url | b64_json) is only valid for the DALL·E models.
  // gpt-image-1 ignores it and always returns base64 — sending it triggers a 400.
  const isDalle = /^dall-e/i.test(model);
  if (isDalle) {
    body.response_format = args.response_format ? String(args.response_format).trim() : "url";
    if (args.style) body.style = String(args.style).trim(); // dall-e-3: "vivid" | "natural"
  } else {
    // gpt-image-1 extras
    if (args.background) body.background = String(args.background).trim();
    if (args.output_format) body.output_format = String(args.output_format).trim();
  }

  return body;
}

// Summarize the generation response so the result that flows back to the agent
// stays small when URLs are available, while still surfacing base64 when that is
// all the model returns (gpt-image-1). The full image payload remains in the
// returned structuredContent.
function summarizeImageResponse(model: string, json: any) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const images = data.map((item: any) => ({
    ...(item?.url ? { url: item.url } : {}),
    ...(item?.b64_json ? { b64_json: item.b64_json } : {}),
    ...(item?.revised_prompt ? { revised_prompt: item.revised_prompt } : {}),
  }));
  const hasUrls = images.some((img: any) => img.url);
  const notes: string[] = [];
  if (!hasUrls && images.length) {
    notes.push(
      "Images returned as base64 (b64_json). gpt-image-1 does not return URLs; " +
        "decode b64_json to get the PNG, or use a dall-e-3 model with response_format=url for a hosted link.",
    );
  } else if (hasUrls) {
    notes.push("Image URLs are temporary (OpenAI expires them ~60 minutes after generation); download promptly.");
  }
  return { model, created: json?.created, images, ...(notes.length ? { notes } : {}) };
}

export async function callOpenAITool(
  tool: string,
  args: OpenAIArgs,
  rawCredential: string,
) {
  const credential = parseCredential(rawCredential);

  if (tool === "openai/generate_image") {
    const body = buildImageBody(args);
    const json = await request(credential, "POST", "/images/generations", body, tool);
    return { structuredContent: summarizeImageResponse(String(body.model), json) };
  }

  throw new Error(`Unknown OpenAI tool: ${tool}`);
}
