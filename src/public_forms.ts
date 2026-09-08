// Public, unauthenticated form endpoints used by the static marketing site
// (grantry.ai). Each endpoint validates and rate-limits the submission, then
// writes to the CRM through Grantry's own MCP gateway with a dedicated agent
// token (SEMINAR_FORM_AGENT_TOKEN). Going through /mcp instead of holding a
// raw CRM key here means the write is scoped, revocable, and audited like any
// other governed tool call.
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

export const publicFormsApp = new Hono();

const ALLOWED_ORIGINS = new Set([
  "https://grantry.ai",
  "https://www.grantry.ai",
  "http://localhost:4177",
  "http://127.0.0.1:4177",
]);

// Sliding window per client IP. In-memory is fine: one instance, and the
// worst case on restart is a briefly reset counter.
const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function clientIp(c: any): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

function mcpUrl(): string {
  if (process.env.SEMINAR_FORM_MCP_URL) return process.env.SEMINAR_FORM_MCP_URL;
  // Loopback: the gateway lives in this same process.
  return `http://127.0.0.1:${process.env.PORT ?? 3000}/mcp`;
}

async function mcpCall(tool: string, args: Record<string, unknown>): Promise<any> {
  const token = process.env.SEMINAR_FORM_AGENT_TOKEN;
  if (!token) throw new Error("SEMINAR_FORM_AGENT_TOKEN is not set");
  const r = await fetch(mcpUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "grantry/public-forms",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(20_000),
  });
  let payload = (await r.text()).trim();
  if (payload.startsWith("event:") || payload.startsWith("data:")) {
    const lines = payload.split("\n").filter((l) => l.startsWith("data:"));
    payload = lines[lines.length - 1]?.slice(5).trim() ?? "";
  }
  const j = JSON.parse(payload);
  if (j.error) throw new Error(`mcp ${tool}: ${j.error.message ?? JSON.stringify(j.error)}`);
  const result = j.result ?? {};
  if (result.isError) throw new Error(`mcp ${tool}: ${result.content?.[0]?.text ?? "tool error"}`);
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((p: any) => p.type === "text")?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return result;
}

const str = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);
const list = (v: unknown, max = 10): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map((x) => str(x, 120)).filter(Boolean).slice(0, max);

async function readBody(c: any): Promise<Record<string, unknown>> {
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) return (await c.req.json()) as Record<string, unknown>;
  const form = await c.req.formData();
  const out: Record<string, unknown> = {};
  for (const key of new Set<string>(form.keys())) {
    const all = form.getAll(key).map((v: FormDataEntryValue) => String(v));
    out[key.replace(/\[\]$/, "")] = all.length > 1 ? all : all[0];
  }
  return out;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.split(/[\s　]+/).filter(Boolean);
  if (parts.length >= 2) return { lastName: parts[0], firstName: parts.slice(1).join(" ") };
  return { firstName: full, lastName: "" };
}

function firstArray(obj: any): any[] {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) {
      const found = firstArray(v);
      if (found.length) return found;
    }
  }
  return [];
}

// Best effort: link the submission to a person (find by email, else create).
// Never throws — the submission record already exists by the time this runs.
async function upsertPerson(scope: string, f: { name: string; email: string; company: string; jobTitle: string; seminar: string }): Promise<string | null> {
  try {
    const found = await mcpCall("twenty_list_records", {
      scope,
      object: "people",
      filter: `emails.primaryEmail[eq]:${f.email}`,
      limit: 1,
    });
    const existing = firstArray(found?.data ?? found)[0];
    if (existing?.id) return String(existing.id);
    const created = await mcpCall("twenty_create_record", {
      scope,
      object: "people",
      data: {
        name: splitName(f.name),
        emails: { primaryEmail: f.email },
        ...(f.jobTitle ? { jobTitle: f.jobTitle } : {}),
        ...(f.company ? { companyNameRaw: f.company } : {}),
        leadChannel: "seminar",
        leadType: "seminar-survey",
        leadDate: new Date().toISOString(),
        conversionName: f.seminar ? `セミナーアンケート: ${f.seminar}` : "セミナーアンケート",
        leadProduct: "grantry",
      },
    });
    const person = created?.data ? firstArray(created.data)[0] ?? Object.values(created.data)[0] : created;
    return person?.id ? String(person.id) : null;
  } catch (err) {
    console.error("[public-forms] person upsert failed:", err);
    return null;
  }
}

publicFormsApp.post("/seminar-survey", async (c) => {
  const origin = c.req.header("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return c.json({ ok: false, error: "origin not allowed" }, 403);
  if (rateLimited(clientIp(c))) return c.json({ ok: false, error: "too many submissions, try again later" }, 429);

  let body: Record<string, unknown>;
  try {
    body = await readBody(c);
  } catch {
    return c.json({ ok: false, error: "invalid body" }, 400);
  }

  // Honeypot: real users never see this field.
  if (str(body.website)) return c.json({ ok: true, id: null });

  const name = str(body.name, 120);
  const email = str(body.email, 200).toLowerCase();
  const company = str(body.company, 200);
  const jobTitle = str(body.jobTitle ?? body.job_title, 120);
  const seminar = str(body.seminar, 200);
  const satisfaction = Number(str(body.satisfaction, 2));
  const interests = list(body.interests);
  const agentStatus = str(body.agentStatus ?? body.agent_status, 120);
  const followUp = list(body.followUp ?? body.follow_up);
  const comment = str(body.comment, 4000);
  const pageUrl = str(body.pageUrl ?? body.page_url, 500);

  const errors: string[] = [];
  if (!name) errors.push("name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("email");
  if (!Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5) errors.push("satisfaction");
  if (errors.length) return c.json({ ok: false, error: "invalid fields", fields: errors }, 400);

  const scope = process.env.SEMINAR_FORM_TWENTY_SCOPE ?? "gtm";
  const submittedAt = new Date().toISOString();
  const conversionId = `site:seminar-survey:${randomUUID()}`;
  const payload = { name, email, company, jobTitle, seminar, satisfaction, interests, agentStatus, followUp, comment, pageUrl, userAgent: str(c.req.header("user-agent"), 300) };

  try {
    const personId = await upsertPerson(scope, { name, email, company, jobTitle, seminar });
    const created = await mcpCall("twenty_create_record", {
      scope,
      object: "formSubmissions",
      data: {
        name: `${seminar || "セミナーアンケート"} — ${name}`,
        submittedAt,
        email,
        formName: "セミナーアンケート",
        formId: "grantry-site/ja/seminar-survey",
        conversionId,
        pageUrl: /^https:\/\/(www\.)?grantry\.ai\//.test(pageUrl) ? pageUrl : "https://grantry.ai/ja/seminar-survey/",
        payload,
        ...(personId ? { personId } : {}),
      },
    });
    const record = created?.data ? firstArray(created.data)[0] ?? Object.values(created.data)[0] : created;
    console.log("[public-forms] seminar-survey stored", { conversionId, personId, recordId: record?.id ?? null });
    return c.json({ ok: true, id: conversionId });
  } catch (err) {
    console.error("[public-forms] seminar-survey failed:", err);
    return c.json({ ok: false, error: "could not store the submission" }, 502);
  }
});
