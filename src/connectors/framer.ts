// Framer connector - build and preview pages in a Framer project through the
// official Framer Server API (`framer-api`). Unlike most connectors this is not an
// HTTP proxy: framer-api opens a session to the project over its own transport,
// so every tool call connects, runs one operation and disconnects.
//
// Credential: Framer API keys are issued per project (Project settings -> API Keys),
// so a connection needs both the project and the key. Accepted formats:
//   {"project":"https://framer.com/projects/Site--abc123","api_key":"..."}   (JSON)
//   https://framer.com/projects/Site--abc123|<api key>                       (pipe)
//
// Safety: arbitrary code execution is deliberately not exposed, and publishing is
// limited to branch previews. `deploy_to_production` is never sent, and preview
// publishing is refused while the main branch is active.
const CALL_TIMEOUT_MS = 90_000;
const CONNECT_TIMEOUT_MS = 30_000;

type FramerArgs = Record<string, unknown>;

export type FramerCredential = { project: string; apiKey: string };

// Minimal surface of framer-api that this connector uses. Kept structural so the
// client can be replaced in tests without loading the real package.
export type FramerClient = {
  getProjectInfo(): Promise<unknown>;
  disconnect(): Promise<void> | void;
  agent: {
    getSystemPrompt(): Promise<string>;
    getContext(): Promise<string>;
    getActiveBranch(): Promise<unknown>;
    getBranches(): Promise<unknown[]>;
    createBranch(title?: string): Promise<unknown>;
    switchBranch(branchId: string): Promise<void>;
    readProject(queries: Record<string, unknown>[], options?: { pagePath?: string }): Promise<unknown>;
    applyChanges(dsl: string, options?: { pagePath?: string }): Promise<unknown>;
    publish(input?: Record<string, unknown>): Promise<unknown>;
  };
};

export type FramerConnect = (project: string, apiKey: string) => Promise<FramerClient>;

export function parseFramerCredential(raw: string): FramerCredential {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error('Framer credential is required: {"project":"<project URL or id>","api_key":"<key>"}');
  let project = "";
  let apiKey = "";
  if (trimmed.startsWith("{")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("Framer credential JSON could not be parsed");
    }
    project = String(parsed.project ?? parsed.project_url ?? parsed.projectUrl ?? parsed.project_id ?? "").trim();
    apiKey = String(parsed.api_key ?? parsed.apiKey ?? parsed.token ?? "").trim();
  } else {
    const at = trimmed.lastIndexOf("|");
    if (at > 0) {
      project = trimmed.slice(0, at).trim();
      apiKey = trimmed.slice(at + 1).trim();
    }
  }
  if (!project || !apiKey) {
    throw new Error('Framer credential must include both the project and its API key: {"project":"<project URL or id>","api_key":"<key>"} or "<project URL or id>|<key>"');
  }
  return { project, apiKey };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Framer ${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

const defaultConnect: FramerConnect = async (project, apiKey) => {
  const mod: any = await import("framer-api");
  return mod.connect(project, apiKey) as Promise<FramerClient>;
};

// Never let the API key travel back to the caller inside an error message.
function scrub(message: string, credential: FramerCredential): string {
  return credential.apiKey ? message.split(credential.apiKey).join("[redacted]") : message;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pageOptions(args: FramerArgs): { pagePath?: string } | undefined {
  const pagePath = str(args.page_path ?? args.pagePath ?? args.page);
  return pagePath ? { pagePath } : undefined;
}

function branchId(branch: unknown): string {
  if (branch && typeof branch === "object") {
    const b = branch as Record<string, unknown>;
    return String(b.id ?? b.branchId ?? "");
  }
  return "";
}

function isMainBranch(branch: unknown): boolean {
  if (!branch || typeof branch !== "object") return true; // unknown -> treat as main (fail closed)
  const b = branch as Record<string, unknown>;
  if (b.isMain === true || b.main === true) return true;
  const id = branchId(branch);
  return !id || id === "main";
}

async function run(tool: string, args: FramerArgs, framer: FramerClient): Promise<unknown> {
  if (tool === "framer/get_project_info") {
    const [project, branch] = await Promise.all([framer.getProjectInfo(), framer.agent.getActiveBranch().catch(() => null)]);
    return { ok: true, project, active_branch: branch };
  }

  if (tool === "framer/get_agent_system_prompt") {
    return { system_prompt: await framer.agent.getSystemPrompt() };
  }

  if (tool === "framer/get_agent_context") {
    return { context: await framer.agent.getContext() };
  }

  if (tool === "framer/list_branches") {
    const [active, branches] = await Promise.all([framer.agent.getActiveBranch(), framer.agent.getBranches()]);
    return { active_branch: active, branches };
  }

  if (tool === "framer/create_branch") {
    const title = str(args.title);
    const branch = await framer.agent.createBranch(title || undefined);
    return { branch };
  }

  if (tool === "framer/switch_branch") {
    const id = str(args.branch_id ?? args.branchId);
    if (!id) throw new Error("branch_id is required");
    await framer.agent.switchBranch(id);
    return { active_branch: await framer.agent.getActiveBranch() };
  }

  if (tool === "framer/read_project") {
    const queries = args.queries;
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new Error("queries must be a non-empty array (query types are documented by framer/get_agent_system_prompt)");
    }
    return framer.agent.readProject(queries as Record<string, unknown>[], pageOptions(args));
  }

  if (tool === "framer/apply_changes") {
    const dsl = str(args.dsl);
    if (!dsl) throw new Error("dsl is required (command syntax is documented by framer/get_agent_system_prompt)");
    const switchTo = str(args.branch_id ?? args.branchId);
    if (switchTo) await framer.agent.switchBranch(switchTo);
    const result = await framer.agent.applyChanges(dsl, pageOptions(args));
    return { result, active_branch: await framer.agent.getActiveBranch().catch(() => null) };
  }

  if (tool === "framer/publish_preview") {
    const switchTo = str(args.branch_id ?? args.branchId);
    if (switchTo) await framer.agent.switchBranch(switchTo);
    const active = await framer.agent.getActiveBranch();
    if (isMainBranch(active)) {
      throw new Error("framer/publish_preview only publishes a branch preview. The main branch is active; create or switch to a branch first (framer/create_branch). Production publishing is not available through Grantry.");
    }
    const preview = await framer.agent.publish({ action: "preview" });
    if (args.confirm !== true) return { active_branch: active, preview, confirmed: false };
    const confirmed = await framer.agent.publish({ action: "confirm_publish" });
    return { active_branch: active, preview, confirmed: true, publish: confirmed };
  }

  throw new Error(`Unknown Framer tool: ${tool}`);
}

export async function callFramerTool(
  tool: string,
  args: FramerArgs,
  rawCredential: string,
  connect: FramerConnect = defaultConnect,
) {
  const credential = parseFramerCredential(rawCredential);
  let framer: FramerClient | undefined;
  try {
    framer = await withTimeout(connect(credential.project, credential.apiKey), CONNECT_TIMEOUT_MS, "connect");
    const result = await withTimeout(run(tool, args ?? {}, framer), CALL_TIMEOUT_MS, tool);
    const structuredContent = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
    return { structuredContent };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(scrub(message, credential));
  } finally {
    if (framer) {
      try {
        await framer.disconnect();
      } catch {
        // the session is gone either way
      }
    }
  }
}
