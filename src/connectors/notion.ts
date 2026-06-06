// Notion connector — internal integration tokens (no OAuth flow)
// Calls the Notion API using the stored PAT.
import { decrypt } from "../crypto.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

type NotionArgs = Record<string, unknown>;

function positiveInt(value: unknown, fallback: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

async function readAllBlockChildren(blockId: string, headers: Record<string, string>, pageSize = 100) {
  const results: any[] = [];
  let startCursor: string | undefined;

  do {
    const url = new URL(`${NOTION_API}/blocks/${blockId}/children`);
    url.searchParams.set("page_size", String(pageSize));
    if (startCursor) url.searchParams.set("start_cursor", startCursor);

    const r = await fetch(url, { headers });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion get block children failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);

    results.push(...(j.results ?? []));
    startCursor = j.has_more ? j.next_cursor : undefined;
  } while (startCursor);

  return results;
}

function buildDbQueryBody(args: NotionArgs) {
  const body: Record<string, unknown> = {};
  if (args.filter) body.filter = args.filter;
  if (args.sorts) body.sorts = args.sorts;
  if (args.start_cursor) body.start_cursor = args.start_cursor;
  body.page_size = positiveInt(args.page_size, 100, 100);

  const slug = String(args.slug ?? "").trim();
  if (slug) {
    const slugProperty = String(args.slug_property ?? "Slug");
    const slugFilter = { property: slugProperty, rich_text: { equals: slug } };
    body.filter = body.filter ? { and: [body.filter, slugFilter] } : slugFilter;
  }

  return body;
}

export async function callNotionTool(tool: string, args: NotionArgs, token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  if (tool === "notion/list_dbs") {
    const r = await fetch(`${NOTION_API}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ filter: { property: "object", value: "database" } }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion list_dbs failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return {
      structuredContent: {
        results: (j.results ?? []).map((db: any) => ({
          id: db.id,
          title: db.title?.[0]?.plain_text ?? "(untitled)",
          url: db.url,
        })),
      },
    };
  }

  if (tool === "notion/get_page") {
    const pageId = String(args.page_id ?? "");
    if (!pageId) throw new Error("page_id is required");
    const r = await fetch(`${NOTION_API}/pages/${pageId}`, { headers });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion get_page failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    const includeChildren = Boolean(args.include_children);
    return {
      structuredContent: {
        id: j.id,
        url: j.url,
        properties: j.properties,
        archived: j.archived,
        children: includeChildren ? await readAllBlockChildren(pageId, headers) : undefined,
      },
    };
  }

  if (tool === "notion/query_db") {
    const dbId = String(args.database_id ?? "");
    if (!dbId) throw new Error("database_id is required");
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildDbQueryBody(args)),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion query_db failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return { structuredContent: { results: j.results ?? [], has_more: j.has_more, next_cursor: j.next_cursor ?? null } };
  }

  if (tool === "notion/create_page") {
    const parent = args.parent as any;
    const properties = args.properties as any;
    if (!parent || !properties) throw new Error("parent and properties are required");
    const r = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parent, properties }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion create_page failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return { structuredContent: { id: j.id, url: j.url } };
  }

  if (tool === "notion/update_page") {
    const pageId = String(args.page_id ?? "");
    const properties = args.properties as any;
    const archived = args.archived;
    const icon = args.icon;
    const cover = args.cover;
    if (!pageId) throw new Error("page_id is required");
    if (!properties && archived === undefined && icon === undefined && cover === undefined) {
      throw new Error("one of properties, archived, icon, or cover is required");
    }

    const body: Record<string, unknown> = {};
    if (properties) body.properties = properties;
    if (archived !== undefined) body.archived = Boolean(archived);
    if (icon !== undefined) body.icon = icon;
    if (cover !== undefined) body.cover = cover;

    const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion update_page failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return { structuredContent: { id: j.id, url: j.url, properties: j.properties, archived: j.archived } };
  }

  if (tool === "notion/append_blocks") {
    const parentBlockId = String(args.parent_block_id ?? args.page_id ?? "");
    const children = args.children as any[];
    const after = args.after ? String(args.after) : undefined;
    if (!parentBlockId) throw new Error("parent_block_id or page_id is required");
    if (!Array.isArray(children) || children.length === 0) throw new Error("children must be a non-empty array");

    const body: Record<string, unknown> = { children };
    if (after) body.after = after;

    const r = await fetch(`${NOTION_API}/blocks/${parentBlockId}/children`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion append_blocks failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return { structuredContent: { results: j.results ?? [], has_more: j.has_more, next_cursor: j.next_cursor ?? null } };
  }

  if (tool === "notion/update_blocks") {
    const operations = args.operations as any[];
    if (!Array.isArray(operations) || operations.length === 0) throw new Error("operations must be a non-empty array");
    if (operations.length > 25) throw new Error("operations is limited to 25 items");

    const results = [];
    for (const op of operations) {
      const blockId = String(op?.block_id ?? "");
      if (!blockId) throw new Error("each operation requires block_id");
      const patch = op?.patch ?? (op?.archived !== undefined ? { archived: Boolean(op.archived) } : null);
      if (!patch || typeof patch !== "object") throw new Error("each operation requires patch or archived");

      const r = await fetch(`${NOTION_API}/blocks/${blockId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(`Notion update_blocks failed for ${blockId}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
      results.push({ id: j.id, type: j.type, archived: j.archived });
    }
    return { structuredContent: { results } };
  }

  if (tool === "notion/update_page_status") {
    const pageId = String(args.page_id ?? "");
    const statusProp = String(args.status ?? "");
    const statusName = String(args.status_name ?? "Done");
    if (!pageId) throw new Error("page_id is required");
    // Heuristic: find a property of type "status" and update it
    const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        properties: {
          [statusProp]: { status: { name: statusName } },
        },
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion update_page_status failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return { structuredContent: { id: j.id, url: j.url, properties: j.properties } };
  }

  throw new Error(`Unknown Notion tool: ${tool}`);
}
