// SendGrid connector - API key authentication via Authorization: Bearer <key>.
// Targets the SendGrid Web API v3.
const SENDGRID_API = "https://api.sendgrid.com/v3";
const SENDGRID_TIMEOUT_MS = 12_000;

type SendGridArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function headers(apiKey: string, json = false) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function fetchSendGrid(
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENDGRID_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[sendgrid] request", { path, ...logContext });
    const response = await fetch(`${SENDGRID_API}${path}`, {
      ...init,
      signal: controller.signal,
    });
    console.log("[sendgrid] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[sendgrid] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted
        ? `timeout after ${SENDGRID_TIMEOUT_MS}ms`
        : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted)
      throw new Error(
        `SendGrid request timed out after ${SENDGRID_TIMEOUT_MS}ms`,
      );
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: SendGridArgs, snake: string, aliases: string[] = []) {
  const candidates = [
    snake,
    snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
    ...aliases,
  ];
  for (const key of candidates) {
    const value = String(args[key] ?? "").trim();
    if (value) return value;
  }
  throw new Error(`${snake} is required`);
}

function queryString(
  args: SendGridArgs,
  keys: Array<string | [string, string]>,
) {
  const params = new URLSearchParams();
  for (const entry of keys) {
    const [argKey, paramKey] = Array.isArray(entry) ? entry : [entry, entry];
    const value =
      args[argKey] ??
      args[argKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    if (value === undefined || value === null || value === "") continue;
    params.set(paramKey, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(
  apiKey: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {},
) {
  const init: RequestInit = {
    method,
    headers: headers(apiKey, body !== undefined),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchSendGrid(path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok)
    throw new Error(
      `SendGrid ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`,
    );
  return j;
}

function buildEmailBody(args: SendGridArgs): Record<string, unknown> {
  // Raw data passthrough
  if (args.data && typeof args.data === "object" && !Array.isArray(args.data)) {
    return args.data as Record<string, unknown>;
  }

  const from = String(args.from ?? "").trim();
  const to = String(args.to ?? "").trim();
  const subject = String(args.subject ?? "").trim();
  const text = args.text ? String(args.text) : undefined;
  const html = args.html ? String(args.html) : undefined;

  if (!from) throw new Error("from is required");
  if (!to) throw new Error("to is required");
  if (!subject) throw new Error("subject is required");
  if (!text && !html) throw new Error("one of text or html is required");

  const content: Array<{ type: string; value: string }> = [];
  if (text) content.push({ type: "text/plain", value: text });
  if (html) content.push({ type: "text/html", value: html });

  return {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from },
    subject,
    content,
  };
}

export async function callSendGridTool(
  tool: string,
  args: SendGridArgs,
  credential: string,
) {
  if (tool === "sendgrid/send_email") {
    return {
      structuredContent: await request(
        credential,
        "POST",
        "/mail/send",
        buildEmailBody(args),
        tool,
      ),
    };
  }

  if (tool === "sendgrid/list_templates") {
    const qs = queryString(args, [["page_size", "page_size"]]);
    // generations=dynamic is always appended; merge with any other qs params
    const base = "/templates?generations=dynamic";
    const extra = qs ? `&${qs.slice(1)}` : "";
    return {
      structuredContent: await request(
        credential,
        "GET",
        `${base}${extra}`,
        undefined,
        tool,
      ),
    };
  }

  if (tool === "sendgrid/get_template") {
    const templateId = idArg(args, "template_id");
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/templates/${encodeURIComponent(templateId)}`,
        undefined,
        tool,
        { templateId },
      ),
    };
  }

  if (tool === "sendgrid/get_stats") {
    const startDate = idArg(args, "start_date");
    const qs = queryString(args, [
      ["end_date", "end_date"],
      ["aggregated_by", "aggregated_by"],
    ]);
    const base = `/stats?start_date=${encodeURIComponent(startDate)}`;
    const extra = qs ? `&${qs.slice(1)}` : "";
    return {
      structuredContent: await request(
        credential,
        "GET",
        `${base}${extra}`,
        undefined,
        tool,
      ),
    };
  }

  if (tool === "sendgrid/list_bounces") {
    const qs = queryString(args, [
      ["start_time", "start_time"],
      ["end_time", "end_time"],
    ]);
    return {
      structuredContent: await request(
        credential,
        "GET",
        `/suppression/bounces${qs}`,
        undefined,
        tool,
      ),
    };
  }

  if (tool === "sendgrid/list_api_keys") {
    return {
      structuredContent: await request(
        credential,
        "GET",
        "/api_keys",
        undefined,
        tool,
      ),
    };
  }

  throw new Error(`Unknown SendGrid tool: ${tool}`);
}
