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
    // Uses Git Data API to push a tree of files in a single commit
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    const branch = String(args.branch ?? "main");
    const commit_message = String(args.commit_message ?? "chore: update via agent-oauth");
    const files = (args.files ?? {}) as Record<string, string>;
    if (!owner || !repo) throw new Error("owner and repo are required");
    if (Object.keys(files).length === 0) throw new Error("files (object) is required");

    // 1. Get current commit SHA for the branch
    const refRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers });
    if (!refRes.ok) {
      if (refRes.status === 404) {
        // Branch doesn't exist — try main first
        if (branch !== "main") {
          return await callGitHubTool("github/git_push_repo", { ...args, branch: "main" }, token);
        }
        throw new Error(`Branch ${branch} not found: ${refRes.status}`);
      }
      throw new Error(`git/ref failed: ${refRes.status} ${await refRes.text()}`);
    }
    const ref: any = await refRes.json();
    const parentSha = ref.object.sha;

    // 2. Get the parent commit (for tree base)
    const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits/${parentSha}`, { headers });
    if (!commitRes.ok) throw new Error(`git/commits failed: ${commitRes.status}`);
    const parentCommit: any = await commitRes.json();
    const baseTreeSha = parentCommit.tree.sha;

    // 3. Create blobs for each file
    const blobs = await Promise.all(
      Object.entries(files).map(async ([path, content]) => {
        const blobRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
          method: "POST", headers,
          body: JSON.stringify({ content, encoding: "utf-8" }),
        });
        if (!blobRes.ok) throw new Error(`git/blobs failed for ${path}: ${blobRes.status}`);
        const blob: any = await blobRes.json();
        return { path, sha: blob.sha };
      })
    );

    // 4. Create a tree
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
      method: "POST", headers,
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
      }),
    });
    if (!treeRes.ok) throw new Error(`git/trees failed: ${treeRes.status}`);
    const tree: any = await treeRes.json();

    // 5. Create commit
    const newCommitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
      method: "POST", headers,
      body: JSON.stringify({ message: commit_message, tree: tree.sha, parents: [parentSha] }),
    });
    if (!newCommitRes.ok) throw new Error(`git/commits POST failed: ${newCommitRes.status}`);
    const newCommit: any = await newCommitRes.json();

    // 6. Update ref
    const updateRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH", headers,
      body: JSON.stringify({ sha: newCommit.sha }),
    });
    if (!updateRefRes.ok) throw new Error(`git/refs PATCH failed: ${updateRefRes.status}`);

    return {
      structuredContent: {
        commit_sha: newCommit.sha,
        files_pushed: Object.keys(files).length,
        url: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
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
