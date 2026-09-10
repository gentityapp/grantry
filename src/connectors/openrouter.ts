// OpenRouter connector - API key authentication via Authorization: Bearer <key>.
// Targets the OpenRouter REST API v1 (OpenAI-compatible). The headline tool is
// chat completion (POST /chat/completions) routed to any model on the catalog;
// the rest read the model catalog, key limits, credit balance and per-generation
// cost. Generic calls go through openrouter/request.
//
// Credential: paste an OpenRouter API key (sk-or-v1-...), or JSON
//   {"api_key":"sk-or-v1-...","referer":"https://app.example.com","title":"Your App"}
// to attach the optional HTTP-Referer / X-Title app-attribution headers that
// OpenRouter uses for its public app rankings.
const OPENROUTER_API = "https://openrouter.ai/api/v1";
const OPENROUTER_TIMEOUT_MS = 120_000; // long completions / reasoning models can take a while
const DEFAULT_MODEL = "openrouter/auto";

type OpenRouterArgs = Record<string, unknown>;

type OpenRouterCredential = {
  apiKey: string;
  referer?: string;
  title?: string;
};

export function parseOpenRouterCredential(raw: string): OpenRouterCredential {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.startsWith("{")) {
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('OpenRouter credential JSON is invalid; expected {"api_key":"sk-or-v1-..."}');
    }
    const apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
    if (!apiKey) throw new Error("OpenRouter credential JSON must include api_key");
    const referer = String(parsed.referer ?? parsed.http_referer ?? parsed.site_url ?? "").trim();
    const title = String(parsed.title ?? parsed.x_title ?? parsed.app_name ?? "").trim();
    return {
      apiKey,
      ...(referer ? { referer } : {}),
      ...(title ? { title } : {}),
    };
  }
  if (!trimmed) throw new Error("OpenRouter API key is required");
  return { apiKey: trimmed };
}

function headers(credential: OpenRouterCredential): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${credential.apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (credential.referer) h["HTTP-Referer"] = credential.referer;
  if (credential.title) h["X-Title"] = credential.title;
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
  credential: OpenRouterCredential,
  method: string,
  path: string,
  body: unknown,
  tool: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[openrouter] request", { path, tool });
    const init: RequestInit = { method, headers: headers(credential), signal: controller.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await fetch(`${OPENROUTER_API}${path}`, init);
    console.log("[openrouter] response", { path, tool, status: r.status, durationMs: Date.now() - started });
    const j: any = await readJsonResponse(r);
    if (!r.ok) {
      const message = j?.error?.message ?? j?.error ?? JSON.stringify(j).slice(0, 1000);
      throw new Error(`OpenRouter ${tool} failed: ${r.status} ${typeof message === "string" ? message : JSON.stringify(message)}`);
    }
    // OpenRouter also reports upstream provider failures as 200 + {error:{...}}
    // inside a completion response (e.g. a provider that was down mid-stream).
    if (j && typeof j === "object" && j.error && !j.choices && !j.data) {
      const message = j.error?.message ?? JSON.stringify(j.error).slice(0, 1000);
      throw new Error(`OpenRouter ${tool} failed: ${typeof message === "string" ? message : JSON.stringify(message)}`);
    }
    return j;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`OpenRouter request timed out after ${OPENROUTER_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function queryString(params: Record<string, unknown>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

function buildChatBody(args: OpenRouterArgs): Record<string, unknown> {
  const model = String(args.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  // Accept either a full OpenAI-style messages array or a prompt/system pair.
  let messages: unknown[] = [];
  if (Array.isArray(args.messages) && args.messages.length) {
    messages = args.messages;
  } else {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("messages (array) or prompt (string) is required");
    const system = String(args.system ?? "").trim();
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
  }

  const body: Record<string, unknown> = { model, messages, stream: false };

  // Standard sampling / output controls (OpenAI-compatible names).
  for (const key of ["temperature", "top_p", "max_tokens", "seed", "stop", "frequency_penalty", "presence_penalty"] as const) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== "") body[key] = args[key];
  }
  if (args.response_format) body.response_format = args.response_format;
  if (Array.isArray(args.tools) && args.tools.length) body.tools = args.tools;
  if (args.tool_choice) body.tool_choice = args.tool_choice;

  // OpenRouter-specific routing controls.
  if (Array.isArray(args.models) && args.models.length) body.models = args.models; // fallback chain
  if (args.provider && typeof args.provider === "object") body.provider = args.provider; // provider preferences
  if (args.reasoning && typeof args.reasoning === "object") body.reasoning = args.reasoning;
  if (Array.isArray(args.transforms)) body.transforms = args.transforms;
  if (args.user) body.user = String(args.user);

  // Ask OpenRouter to include cost/token accounting in the response so the
  // agent sees spend without a second get_generation call.
  body.usage = { include: true };

  if (args.extra && typeof args.extra === "object") Object.assign(body, args.extra as Record<string, unknown>);
  return body;
}

// Keep the result that flows back to the agent small: the assistant text (or
// tool calls), which model actually served it, and the usage/cost block.
function summarizeChatResponse(json: any) {
  const choices = Array.isArray(json?.choices) ? json.choices : [];
  const outputs = choices.map((c: any) => {
    const message = c?.message ?? {};
    return {
      index: c?.index,
      role: message.role ?? "assistant",
      content: message.content ?? null,
      ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      ...(Array.isArray(message.tool_calls) && message.tool_calls.length ? { tool_calls: message.tool_calls } : {}),
      finish_reason: c?.finish_reason ?? c?.native_finish_reason ?? null,
    };
  });
  const first = outputs[0];
  return {
    id: json?.id,
    model: json?.model,
    provider: json?.provider,
    created: json?.created,
    text: typeof first?.content === "string" ? first.content : null,
    outputs,
    usage: json?.usage,
    notes: [
      "Cost is in USD credits (usage.cost) when OpenRouter returns it; fetch openrouter/get_generation with id for the full accounting.",
    ],
  };
}

function summarizeModels(json: any, args: OpenRouterArgs) {
  const data = Array.isArray(json?.data) ? json.data : [];
  const filter = String(args.search ?? "").trim().toLowerCase();
  const limit = Number(args.limit ?? 0) || 0;
  let models = data.map((m: any) => ({
    id: m?.id,
    name: m?.name,
    context_length: m?.context_length,
    pricing: m?.pricing ? { prompt: m.pricing.prompt, completion: m.pricing.completion, ...(m.pricing.image ? { image: m.pricing.image } : {}) } : undefined,
    input_modalities: m?.architecture?.input_modalities,
    output_modalities: m?.architecture?.output_modalities,
    supported_parameters: m?.supported_parameters,
  }));
  if (filter) {
    models = models.filter((m: any) => String(m.id ?? "").toLowerCase().includes(filter) || String(m.name ?? "").toLowerCase().includes(filter));
  }
  const total = models.length;
  if (limit > 0) models = models.slice(0, limit);
  return { total, returned: models.length, models };
}

export async function callOpenRouterTool(
  tool: string,
  args: OpenRouterArgs,
  rawCredential: string,
) {
  const credential = parseOpenRouterCredential(rawCredential);

  if (tool === "openrouter/chat") {
    const body = buildChatBody(args);
    const json = await request(credential, "POST", "/chat/completions", body, tool);
    return { structuredContent: summarizeChatResponse(json) };
  }

  if (tool === "openrouter/list_models") {
    const qs = queryString({
      category: args.category,
      supported_parameters: Array.isArray(args.supported_parameters) ? (args.supported_parameters as unknown[]).join(",") : args.supported_parameters,
    });
    const json = await request(credential, "GET", `/models${qs}`, undefined, tool);
    return { structuredContent: summarizeModels(json, args) };
  }

  if (tool === "openrouter/get_key") {
    const json = await request(credential, "GET", "/auth/key", undefined, tool);
    return { structuredContent: json?.data ?? json };
  }

  if (tool === "openrouter/get_credits") {
    const json = await request(credential, "GET", "/credits", undefined, tool);
    const d = json?.data ?? json;
    const totalCredits = Number(d?.total_credits);
    const totalUsage = Number(d?.total_usage);
    return {
      structuredContent: {
        ...d,
        ...(Number.isFinite(totalCredits) && Number.isFinite(totalUsage) ? { remaining: totalCredits - totalUsage } : {}),
      },
    };
  }

  if (tool === "openrouter/get_generation") {
    const id = String(args.id ?? args.generation_id ?? "").trim();
    if (!id) throw new Error("id is required");
    const json = await request(credential, "GET", `/generation${queryString({ id })}`, undefined, tool);
    return { structuredContent: json?.data ?? json };
  }

  throw new Error(`Unknown OpenRouter tool: ${tool}`);
}
