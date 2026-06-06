// GitHub connector — Personal Access Tokens (fine-grained recommended)
// Calls the GitHub REST API using the stored PAT.
type GhArgs = Record<string, unknown>;

export async function callGitHubTool(tool: string, args: GhArgs, token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-oauth",
  };

  if (tool === "github/list_repos") {
    const r = await fetch("https://api.github.com/user/repos?per_page=100", { headers });
    if (!r.ok) throw new Error(`GitHub list_repos failed: ${r.status} ${await r.text()}`);
    const j: any[] = await r.json();
    return {
      structuredContent: {
        results: j.map((repo) => ({
          id: repo.id,
          name: repo.full_name,
          private: repo.private,
          default_branch: repo.default_branch,
        })),
      },
    };
  }

  if (tool === "github/get_repo") {
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    if (!owner || !repo) throw new Error("owner and repo are required");
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!r.ok) throw new Error(`GitHub get_repo failed: ${r.status} ${await r.text()}`);
    return { structuredContent: await r.json() };
  }

  if (tool === "github/list_issues") {
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    if (!owner || !repo) throw new Error("owner and repo are required");
    const state = String(args.state ?? "open");
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=50`, { headers });
    if (!r.ok) throw new Error(`GitHub list_issues failed: ${r.status} ${await r.text()}`);
    return { structuredContent: { results: await r.json() } };
  }

  if (tool === "github/create_issue") {
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    const title = String(args.title ?? "");
    const body = String(args.body ?? "");
    if (!owner || !repo || !title) throw new Error("owner, repo, title are required");
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: "POST", headers,
      body: JSON.stringify({ title, body }),
    });
    if (!r.ok) throw new Error(`GitHub create_issue failed: ${r.status} ${await r.text()}`);
    return { structuredContent: await r.json() };
  }

  if (tool === "github/git_push_repo") {
    // Uses Contents API to push files. Works for both empty and non-empty repos
    // (Git Data API POST /git/blobs and /git/trees 409 on empty repos).
    // Each file PUT creates or updates the file; the first PUT on an empty
    // repo also creates the initial commit + main branch.
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    const branch = String(args.branch ?? "main");
    const commit_message = String(args.commit_message ?? "chore: update via agent-oauth");
    const files = (args.files ?? {}) as Record<string, string>;
    if (!owner || !repo) throw new Error("owner and repo are required");
    if (Object.keys(files).length === 0) throw new Error("files (object) is required");

    // The Contents API requires base64-encoded content. We have UTF-8 strings.
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

    const pushed: { path: string; sha: string; commit_sha: string }[] = [];
    let lastCommitSha = "";

    for (const [path, content] of Object.entries(files)) {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
      const putRes = await fetch(url, {
        method: "PUT", headers,
        body: JSON.stringify({
          message: commit_message,
          content: b64(content),
          branch,
        }),
      });
      if (!putRes.ok) {
        const errBody = await putRes.text();
        throw new Error(`contents PUT failed for ${path}: ${putRes.status} ${errBody}`);
      }
      const j: any = await putRes.json();
      pushed.push({ path, sha: j.content.sha, commit_sha: j.commit.sha });
      lastCommitSha = j.commit.sha;
    }

    return {
      structuredContent: {
        commit_sha: lastCommitSha,
        files_pushed: pushed.length,
        file_shas: pushed.map((p) => ({ path: p.path, sha: p.sha })),
        url: `https://github.com/${owner}/${repo}/commit/${lastCommitSha}`,
      },
    };
  }

  if (tool === "github/create_repo") {
    const name = String(args.name ?? "");
    if (!name) throw new Error("name is required");
    // If `org` is provided, create under that org (requires PAT owner to be
    // an org member with create permission). Otherwise create under the
    // authenticated user's personal account.
    const org = String(args.org ?? "").trim();
    const url = org ? `https://api.github.com/orgs/${org}/repos` : "https://api.github.com/user/repos";
    const r = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify({
        name,
        description: args.description,
        private: args.private ?? false,
        auto_init: false,
      }),
    });
    if (!r.ok) throw new Error(`GitHub create_repo failed: ${r.status} ${await r.text()}`);
    const j: any = await r.json();
    return { structuredContent: { id: j.id, name: j.full_name, url: j.html_url, org: org || null } };
  }

  throw new Error(`Unknown GitHub tool: ${tool}`);
}
