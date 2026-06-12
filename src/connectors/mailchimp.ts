// Mailchimp connector — API key authentication (Basic auth, user="anystring", pass=key).
// Datacenter is parsed from the key suffix: "abc123-us21" → dc="us21".
const MAILCHIMP_TIMEOUT_MS = 12_000;

type MailchimpArgs = Record<string, unknown>;

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseDatacenter(credential: string): { dc: string; base: string; authHeader: string } {
  const key = credential.trim();
  if (!key) throw new Error("Mailchimp API key is empty");
  const dashIdx = key.lastIndexOf("-");
  if (dashIdx === -1 || dashIdx === key.length - 1) {
    throw new Error(
      "Mailchimp API key must end with a datacenter suffix like '-us21'. Got a key with no '-<dc>' suffix."
    );
  }
  const dc = key.slice(dashIdx + 1);
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const authHeader = "Basic " + Buffer.from("anystring:" + key).toString("base64");
  return { dc, base, authHeader };
}

async function fetchMailchimp(
  base: string,
  authHeader: string,
  path: string,
  init: RequestInit,
  logContext: Record<string, unknown>
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAILCHIMP_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[mailchimp] request", { path, ...logContext });
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    console.log("[mailchimp] response", {
      path,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[mailchimp] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${MAILCHIMP_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Mailchimp request timed out after ${MAILCHIMP_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function idArg(args: MailchimpArgs, snake: string) {
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const value = String(args[snake] ?? args[camel] ?? "").trim();
  if (!value) throw new Error(`${snake} is required`);
  return value;
}

function queryString(args: MailchimpArgs, keys: string[]) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const value = args[key] ?? args[camel];
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(
  base: string,
  authHeader: string,
  method: string,
  path: string,
  body: unknown,
  tool: string,
  logContext: Record<string, unknown> = {}
) {
  const hdrs: Record<string, string> = {
    Authorization: authHeader,
    Accept: "application/json",
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  const init: RequestInit = { method, headers: hdrs };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetchMailchimp(base, authHeader, path, init, { tool, ...logContext });
  const j: any = await readJsonResponse(r);
  if (!r.ok) throw new Error(`Mailchimp ${tool} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
  return j;
}

export async function callMailchimpTool(tool: string, args: MailchimpArgs, credential: string) {
  const { base, authHeader } = parseDatacenter(credential);

  if (tool === "mailchimp/ping") {
    return { structuredContent: await request(base, authHeader, "GET", "/ping", undefined, tool) };
  }

  if (tool === "mailchimp/list_lists") {
    const qs = queryString(args, ["count", "offset"]);
    return { structuredContent: await request(base, authHeader, "GET", `/lists${qs}`, undefined, tool) };
  }

  if (tool === "mailchimp/get_list") {
    const listId = idArg(args, "list_id");
    return { structuredContent: await request(base, authHeader, "GET", `/lists/${encodeURIComponent(listId)}`, undefined, tool, { listId }) };
  }

  if (tool === "mailchimp/list_members") {
    const listId = idArg(args, "list_id");
    const qs = queryString(args, ["count", "offset", "status"]);
    return {
      structuredContent: await request(
        base, authHeader, "GET",
        `/lists/${encodeURIComponent(listId)}/members${qs}`,
        undefined, tool, { listId }
      ),
    };
  }

  if (tool === "mailchimp/add_member") {
    const listId = idArg(args, "list_id");
    const emailAddress = String(args.email_address ?? args.emailAddress ?? "").trim();
    if (!emailAddress) throw new Error("email_address is required");
    const status = String(args.status ?? "subscribed").trim() || "subscribed";
    const body: Record<string, unknown> = { email_address: emailAddress, status };
    const mergeFields = args.merge_fields ?? args.mergeFields;
    if (mergeFields !== undefined && mergeFields !== null) body.merge_fields = mergeFields;
    return {
      structuredContent: await request(
        base, authHeader, "POST",
        `/lists/${encodeURIComponent(listId)}/members`,
        body, tool, { listId }
      ),
    };
  }

  if (tool === "mailchimp/list_campaigns") {
    const qs = queryString(args, ["count", "offset"]);
    return { structuredContent: await request(base, authHeader, "GET", `/campaigns${qs}`, undefined, tool) };
  }

  throw new Error(`Unknown Mailchimp tool: ${tool}`);
}
