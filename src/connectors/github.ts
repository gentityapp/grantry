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

  if (tool === "github/get_file_contents") {
    // Read a file or list a directory via the Contents API.
    // - File   -> returns the decoded UTF-8 text (base64 in the API response).
    // - Dir    -> returns the entries (name/path/type/size), so the agent can
    //             discover files (e.g. browse `blog/`) without cloning.
    // `path` may be "" (repo root). `ref` optionally pins a branch/tag/commit.
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    if (!owner || !repo) throw new Error("owner and repo are required");
    const path = String(args.path ?? "").replace(/^\/+/, "");
    const ref = String(args.ref ?? "").trim();
    const url =
      `https://api.github.com/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}` +
      (ref ? `?ref=${encodeURIComponent(ref)}` : "");
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`GitHub get_file_contents failed: ${r.status} ${await r.text()}`);
    const j: any = await r.json();

    if (Array.isArray(j)) {
      return {
        structuredContent: {
          type: "dir",
          path,
          entries: j.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size, sha: e.sha })),
        },
      };
    }

    if (j.type === "file") {
      // Large files (>1MB) come back with content="" and encoding="none"; the
      // caller must fetch the blob by sha in that case.
      const content =
        j.encoding === "base64" && typeof j.content === "string"
          ? Buffer.from(j.content, "base64").toString("utf8")
          : null;
      return {
        structuredContent: {
          type: "file",
          path: j.path,
          size: j.size,
          sha: j.sha,
          encoding: j.encoding,
          truncated: content === null,
          content,
        },
      };
    }

    // Submodule / symlink and other non-file entries: return as-is.
    return { structuredContent: { type: j.type ?? "unknown", path: j.path ?? path, raw: j } };
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
    // Uses the Git Data API (blobs -> tree -> commit -> update ref) so that all
    // listed files land in a SINGLE commit, existing files are updated (the
    // Contents API requires a per-file sha for updates; the tree API does not),
    // and the result matches a normal `git push`. Empty repos (no commits yet)
    // are handled by omitting base_tree/parents and creating the ref.
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    const branch = String(args.branch ?? "main");
    const commit_message = String(args.commit_message ?? "chore: update via agent-oauth");
    const files = (args.files ?? {}) as Record<string, string>;
    if (!owner || !repo) throw new Error("owner and repo are required");
    if (Object.keys(files).length === 0) throw new Error("files (object) is required");

    const base = `https://api.github.com/repos/${owner}/${repo}/git`;
    const gh = async (path: string, init?: RequestInit) => {
      const r = await fetch(`${base}${path}`, { ...init, headers });
      if (!r.ok) throw new Error(`git_push_repo ${init?.method ?? "GET"} ${path} failed: ${r.status} ${await r.text()}`);
      return r.json() as Promise<any>;
    };

    // 1. Resolve the branch's current commit + base tree (404 => empty repo).
    let parentCommitSha: string | null = null;
    let baseTreeSha: string | undefined;
    const refRes = await fetch(`${base}/ref/heads/${encodeURIComponent(branch)}`, { headers });
    if (refRes.ok) {
      const ref: any = await refRes.json();
      parentCommitSha = ref.object.sha;
      const parentCommit = await gh(`/commits/${parentCommitSha}`);
      baseTreeSha = parentCommit.tree.sha;
    } else if (refRes.status !== 404 && refRes.status !== 409) {
      throw new Error(`git_push_repo resolve ref failed: ${refRes.status} ${await refRes.text()}`);
    }

    // 2. Create a blob per file (base64 preserves exact bytes).
    const tree = await Promise.all(
      Object.entries(files).map(async ([path, content]) => {
        const blob = await gh("/blobs", {
          method: "POST",
          body: JSON.stringify({ content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" }),
        });
        return { path, mode: "100644", type: "blob", sha: blob.sha };
      })
    );

    // 3. Build a tree (on top of base_tree when the branch already exists).
    const newTree = await gh("/trees", {
      method: "POST",
      body: JSON.stringify(baseTreeSha ? { base_tree: baseTreeSha, tree } : { tree }),
    });

    // 4. Create the single commit.
    const commit = await gh("/commits", {
      method: "POST",
      body: JSON.stringify({
        message: commit_message,
        tree: newTree.sha,
        parents: parentCommitSha ? [parentCommitSha] : [],
      }),
    });

    // 5. Point the branch at the new commit (PATCH existing, POST to create).
    if (parentCommitSha) {
      await gh(`/refs/heads/${encodeURIComponent(branch)}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
    } else {
      await gh("/refs", {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      });
    }

    return {
      structuredContent: {
        commit_sha: commit.sha,
        files_pushed: tree.length,
        files: tree.map((t) => t.path),
        branch,
        created_branch: !parentCommitSha,
        url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
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
