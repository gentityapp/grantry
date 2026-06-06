import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const NOTION_TOOLS = [
  "notion/list_dbs",
  "notion/get_page",
  "notion/query_db",
  "notion/create_page",
  "notion/update_page",
  "notion/append_blocks",
  "notion/update_blocks",
  "notion/update_page_status",
];

try {
  const roles = await prisma.role.findMany({ orderBy: [{ ownerId: "asc" }, { name: "asc" }] });
  let updated = 0;

  for (const role of roles) {
    let allowedTools = [];
    try {
      const parsed = JSON.parse(role.allowedTools || "[]");
      allowedTools = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    } catch {
      allowedTools = [];
    }

    if (!allowedTools.some((tool) => tool.startsWith("notion/"))) continue;

    const merged = Array.from(new Set([...allowedTools, ...NOTION_TOOLS])).sort();
    if (merged.length === allowedTools.length) continue;

    await prisma.role.update({
      where: { id: role.id },
      data: { allowedTools: JSON.stringify(merged) },
    });

    updated += 1;
    console.log("[backfill-notion-tools] added missing Notion tools", {
      roleId: role.id,
      ownerId: role.ownerId,
      name: role.name,
      added: merged.length - allowedTools.length,
    });
  }

  console.log(`[backfill-notion-tools] complete; updated ${updated} role(s)`);
} finally {
  await prisma.$disconnect();
}
