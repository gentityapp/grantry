// Notion connector — internal integration tokens (no OAuth flow)
// Calls the Notion API using the stored PAT.
import { decrypt } from "../crypto.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

type NotionArgs = Record<string, unknown>;

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
    return { structuredContent: { id: j.id, url: j.url, properties: j.properties, archived: j.archived } };
  }

  if (tool === "notion/query_db") {
    const dbId = String(args.database_id ?? "");
    if (!dbId) throw new Error("database_id is required");
    const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(args.filter ? { filter: args.filter } : {}),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion query_db failed: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
    return { structuredContent: { results: j.results ?? [] } };
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
