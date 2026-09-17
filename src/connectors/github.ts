// GitHub connector — Personal Access Tokens (fine-grained recommended)
// Calls the GitHub REST API using the stored PAT.
type GhArgs = Record<string, unknown>;

export async function callGitHubTool(tool: string, args: GhArgs, token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "grantry",
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
    // Uses the Git Data API (tree -> commit -> update ref) so that all listed
    // files land in a SINGLE commit, existing files are updated (the Contents
    // API requires a per-file sha for updates; the tree API does not), and the
    // result matches a normal `git push`. File contents are inlined into the
    // tree (no per-file blob calls), so the request count stays constant and
    // doesn't trip GitHub's secondary rate limit. Empty repos (no commits yet)
    // are handled by omitting base_tree/parents and creating the ref.
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    const branch = String(args.branch ?? "main");
    const commit_message = String(args.commit_message ?? "chore: update via grantry");
    if (!owner || !repo) throw new Error("owner and repo are required");

    // `files` maps a repo path to its content. Content is EITHER:
    //   - a string            -> UTF-8 text, inlined into the tree (no extra call)
    //   - { content: "..." }  -> same as a plain string
    //   - { base64: "..." }   -> binary bytes, base64-encoded (data: URI prefix ok)
    //   - { url: "https://.." }-> binary; grantry fetches the bytes server-side.
    // The url form is the point of this: it lets an agent commit an image
    // WITHOUT emitting its base64 (~280k chars for a 205KB webp — a model can't
    // transcribe that). Pass the image URL (e.g. an openai_generate_image result
    // or any public URL) and grantry handles the bytes. Binary goes through
    // POST /git/blobs because the Trees API `content` field is UTF-8 text only;
    // binary bytes placed there get corrupted.
    //
    // Some clients send `files` as a JSON STRING; parse that. Critically, do NOT
    // fall through to Object.entries() on a raw string — it iterates by character
    // index and pushes one file per character (named "0","1",… single-char).
    type FileSpec = string | { content?: string; base64?: string; url?: string };
    let files: Record<string, FileSpec>;
    {
      let raw: unknown = args.files;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          throw new Error("files must be an object mapping path -> content (received an unparseable string)");
        }
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("files must be an object mapping path -> content");
      }
      files = raw as Record<string, FileSpec>;
    }
    const fileEntries = Object.entries(files);
    if (fileEntries.length === 0) throw new Error("files (object) is required");

    const base = `https://api.github.com/repos/${owner}/${repo}/git`;
    // GitHub's secondary (abuse) rate limit answers with 429 — or 403 carrying a
    // `Retry-After` header / `x-ratelimit-remaining: 0` + `x-ratelimit-reset`.
    // Retry those with backoff instead of aborting the whole push on one blip.
    // `ghRes` returns the final Response (after retries); callers that need to
    // branch on the status (ref resolution below) use it directly, and `gh` is
    // the ok-or-throw wrapper the rest of the push goes through.
    const ghRes = async (url: string, init?: RequestInit): Promise<Response> => {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(url, { ...init, headers });
        if (r.ok) return r;
        if ((r.status !== 429 && r.status !== 403) || attempt >= 5) return r;
        const retryAfter = Number(r.headers.get("retry-after"));
        const reset = Number(r.headers.get("x-ratelimit-reset"));
        const waitMs =
          retryAfter > 0 ? retryAfter * 1000
          : reset > 0 ? Math.max(1000, reset * 1000 - Date.now())
          : Math.min(2 ** attempt * 1000, 30_000); // exponential backoff, capped at 30s
        await r.text(); // drain the body before retrying
        await new Promise((res) => setTimeout(res, waitMs));
      }
    };
    const gh = async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const r = await ghRes(`${base}${path}`, init);
      if (!r.ok) {
        throw new Error(`git_push_repo ${method} ${path} failed: ${r.status} ${await r.text()}`);
      }
      return r.json() as Promise<any>;
    };

    // 1. Resolve the target branch's current commit + base tree.
    //    If the target branch does NOT exist yet, base the new branch on
    //    `base_branch` (arg) or the repo's default branch, so the new commit
    //    has that branch's commit as its parent AND inherits its full tree.
    //    Without this, a new branch was created as an ORPHAN commit with only
    //    the pushed files (no parent, no base_tree) -> `compare main...branch`
    //    returns "No common ancestor", PRs can't be created, and merging would
    //    delete every untouched file. (Root cause of the 2026-06-16 + 2026-06-20
    //    death-store incidents; the instruction-level "branch from main" knob
    //    could not fix it because the agent cannot influence this resolution.)
    let parentCommitSha: string | null = null;
    let baseTreeSha: string | undefined;
    let branchExists = false;
    // Ref resolution shares the retry net (ghRes) with the rest of the push —
    // a 429 here used to abort with "resolve ref failed" before gh() was reached.
    const refRes = await ghRes(`${base}/ref/heads/${encodeURIComponent(branch)}`);
    if (refRes.ok) {
      const ref: any = await refRes.json();
      parentCommitSha = ref.object.sha;
      const parentCommit = await gh(`/commits/${parentCommitSha}`);
      baseTreeSha = parentCommit.tree.sha;
      branchExists = true;
    } else if (refRes.status === 404 || refRes.status === 409) {
      await refRes.text(); // drain
      // New branch: resolve a base branch to inherit history + tree from.
      let baseBranch = String(args.base_branch ?? args.baseBranch ?? "").trim();
      if (!baseBranch) {
        const repoRes = await ghRes(`https://api.github.com/repos/${owner}/${repo}`);
        if (repoRes.ok) {
          const repoInfo: any = await repoRes.json();
          baseBranch = String(repoInfo.default_branch ?? "main");
        } else {
          await repoRes.text();
        }
      }
      if (baseBranch && baseBranch !== branch) {
        const baseRefRes = await ghRes(`${base}/ref/heads/${encodeURIComponent(baseBranch)}`);
        if (baseRefRes.ok) {
          const baseRef: any = await baseRefRes.json();
          parentCommitSha = baseRef.object.sha;
          const baseCommit = await gh(`/commits/${parentCommitSha}`);
          baseTreeSha = baseCommit.tree.sha;
        } else {
          // Base branch missing too => genuinely empty repo: fall through to an
          // initial (parentless) commit, which is correct for that case.
          await baseRefRes.text();
        }
      }
    } else {
      throw new Error(`git_push_repo resolve ref failed: ${refRes.status} ${await refRes.text()}`);
    }

    // 2. Build tree entries. Text is inlined via the Trees API `content` field
    // (no extra call). Binary (base64/url) MUST become a blob first — the Trees
    // `content` field is UTF-8 only. Blob POSTs are done sequentially, not
    // concurrently: firing them via Promise.all tripped GitHub's secondary rate
    // limit on multi-file pushes. Text-only pushes still cost a constant ~4
    // requests; only binaries add one POST /blobs each.
    const MAX_BLOB_BYTES = 100 * 1024 * 1024; // GitHub blob hard limit
    const tree: Array<Record<string, string>> = [];
    for (const [path, spec] of fileEntries) {
      if (typeof spec === "string") {
        tree.push({ path, mode: "100644", type: "blob", content: spec });
        continue;
      }
      if (spec && typeof spec === "object" && typeof spec.content === "string") {
        tree.push({ path, mode: "100644", type: "blob", content: spec.content });
        continue;
      }
      let b64: string | null = null;
      if (spec && typeof spec === "object" && typeof spec.base64 === "string") {
        b64 = spec.base64.replace(/^data:[^;]+;base64,/, "");
      } else if (spec && typeof spec === "object" && typeof spec.url === "string") {
        const fr = await fetch(spec.url);
        if (!fr.ok) {
          throw new Error(`git_push_repo could not fetch files["${path}"].url (${spec.url}): ${fr.status} ${await fr.text()}`);
        }
        const buf = Buffer.from(await fr.arrayBuffer());
        if (buf.length > MAX_BLOB_BYTES) {
          throw new Error(`files["${path}"] is ${buf.length} bytes; exceeds GitHub's 100MB blob limit`);
        }
        b64 = buf.toString("base64");
      }
      if (b64 === null) {
        throw new Error(`files["${path}"] must be a string, or an object { content } | { base64 } | { url }`);
      }
      const blob = await gh("/blobs", {
        method: "POST",
        body: JSON.stringify({ content: b64, encoding: "base64" }),
      });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }

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

    // 5. Point the branch at the new commit (PATCH existing branch, POST to
    //    create a new one). Keyed on whether the TARGET branch already existed,
    //    not on parentCommitSha (a new branch now also has a parent commit).
    if (branchExists) {
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
        created_branch: !branchExists,
        based_on_parent: Boolean(parentCommitSha),
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

  if (tool === "github/create_pull_request") {
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    const title = String(args.title ?? "");
    const head = String(args.head ?? "").trim();
    if (!owner || !repo) throw new Error("owner and repo are required");
    if (!title) throw new Error("title is required");
    if (!head) throw new Error("head (the branch with changes) is required");

    // Resolve base branch (default to the repo's default branch).
    let base = String(args.base ?? args.base_branch ?? "").trim();
    if (!base) {
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (!repoRes.ok) throw new Error(`GitHub create_pull_request resolve repo failed: ${repoRes.status} ${await repoRes.text()}`);
      const repoInfo: any = await repoRes.json();
      base = String(repoInfo.default_branch ?? "main");
    }
    const draft = args.draft === undefined ? true : Boolean(args.draft);

    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST", headers,
      body: JSON.stringify({ title, head, base, body: args.body ?? "", draft }),
    });
    if (!r.ok) throw new Error(`GitHub create_pull_request failed: ${r.status} ${await r.text()}`);
    const j: any = await r.json();
    return {
      structuredContent: {
        number: j.number,
        url: j.html_url,
        state: j.state,
        draft: j.draft,
        head: j.head?.ref,
        base: j.base?.ref,
      },
    };
  }

  throw new Error(`Unknown GitHub tool: ${tool}`);
}
