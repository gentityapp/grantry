import assert from "node:assert/strict";
import { test } from "node:test";

import { callGitHubTool } from "../../src/connectors/github.js";

type FetchCall = { url: string; init?: RequestInit };

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function installFetchMock(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

// git_push_repo is the only GitHub path that sleeps between 429 retries; record
// the delays and fire them immediately so the retry tests stay fast.
function fastTimeout(waits: number[]) {
  globalThis.setTimeout = ((cb: any, ms?: number, ...rest: any[]) => {
    waits.push(ms ?? 0);
    return originalSetTimeout(cb, 0, ...rest);
  }) as typeof setTimeout;
}

test("github/list_repos sends the GitHub headers and maps repo fields", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const calls = installFetchMock(({ url }) => {
    if (url === "https://api.github.com/user/repos?per_page=100") {
      return jsonResponse([
        { id: 1, full_name: "grantry/grantry", private: false, default_branch: "main" },
        { id: 2, full_name: "grantry/internal", private: true, default_branch: "develop" },
      ]);
    }
    return jsonResponse({ message: "Not Found" }, { status: 404 });
  });

  const result = await callGitHubTool("github/list_repos", {}, "ghp_tok");

  assert.equal(calls.length, 1);
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer ghp_tok");
  assert.equal(headers.Accept, "application/vnd.github+json");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(headers["User-Agent"], "grantry");
  assert.deepEqual(result.structuredContent, {
    results: [
      { id: 1, name: "grantry/grantry", private: false, default_branch: "main" },
      { id: 2, name: "grantry/internal", private: true, default_branch: "develop" },
    ],
  });
});

test("github/create_issue posts the title and body to the repo", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const calls = installFetchMock(({ url, init }) => {
    if (url === "https://api.github.com/repos/octocat/hello/issues" && init?.method === "POST") {
      return jsonResponse({
        id: 501,
        number: 7,
        title: "Bug",
        state: "open",
        html_url: "https://github.com/octocat/hello/issues/7",
      });
    }
    return jsonResponse({ message: "Not Found" }, { status: 404 });
  });

  const result = await callGitHubTool(
    "github/create_issue",
    { owner: "octocat", repo: "hello", title: "Bug", body: "It broke" },
    "ghp_tok"
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/octocat/hello/issues");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer ghp_tok");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { title: "Bug", body: "It broke" });
  assert.equal((result.structuredContent as any).number, 7);
});

test("github/list_repos maps a 401 to an error carrying the status and body", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const calls = installFetchMock(() =>
    jsonResponse(
      { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" },
      { status: 401 }
    )
  );

  await assert.rejects(
    callGitHubTool("github/list_repos", {}, "expired_token"),
    (e: any) => {
      assert.match(String(e.message), /^GitHub list_repos failed: 401 /);
      assert.ok(String(e.message).includes("Bad credentials"));
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test("github/create_issue surfaces a 429 as an error without retrying", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const waits: number[] = [];
  fastTimeout(waits);
  const calls = installFetchMock(() =>
    jsonResponse({ message: "API rate limit exceeded" }, { status: 429 })
  );

  await assert.rejects(
    callGitHubTool("github/create_issue", { owner: "octocat", repo: "hello", title: "Bug" }, "ghp_tok"),
    (e: any) => {
      assert.match(String(e.message), /^GitHub create_issue failed: 429 /);
      assert.ok(String(e.message).includes("API rate limit exceeded"));
      return true;
    }
  );
  // Only git_push_repo retries; the simple tools fail on the first 429.
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("github/git_push_repo retries a 429 honoring retry-after and then succeeds", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const waits: number[] = [];
  fastTimeout(waits);
  let commitsSeen = 0;
  const calls = installFetchMock(({ url, init }) => {
    if (url === "https://api.github.com/repos/grantry/hello/git/ref/heads/main") {
      return jsonResponse({ object: { sha: "parent" } });
    }
    if (url === "https://api.github.com/repos/grantry/hello/git/commits/parent") {
      commitsSeen++;
      if (commitsSeen === 1) {
        return jsonResponse(
          { message: "You have exceeded a secondary rate limit" },
          { status: 429, headers: { "retry-after": "1" } }
        );
      }
      return jsonResponse({ sha: "parent", tree: { sha: "basetree" } });
    }
    if (url === "https://api.github.com/repos/grantry/hello/git/trees") {
      return jsonResponse({ sha: "newtree" });
    }
    if (url === "https://api.github.com/repos/grantry/hello/git/commits") {
      return jsonResponse({ sha: "newcommit" });
    }
    if (url === "https://api.github.com/repos/grantry/hello/git/refs/heads/main") {
      return jsonResponse({ object: { sha: "newcommit" } });
    }
    return jsonResponse({ message: "Not Found" }, { status: 404 });
  });

  const result = await callGitHubTool(
    "github/git_push_repo",
    { owner: "grantry", repo: "hello", files: { "README.md": "# hi" } },
    "ghp_tok"
  );

  // ref resolve + 2 commit fetches (1 retry) + trees + commit + ref update
  assert.equal(calls.length, 6);
  assert.equal(calls[1].url, "https://api.github.com/repos/grantry/hello/git/commits/parent");
  assert.deepEqual(waits, [1000]); // retry-after: 1 (seconds)
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), {
    base_tree: "basetree",
    tree: [{ path: "README.md", mode: "100644", type: "blob", content: "# hi" }],
  });
  assert.deepEqual(JSON.parse(String(calls[4].init?.body)), {
    message: "chore: update via grantry",
    tree: "newtree",
    parents: ["parent"],
  });
  assert.equal(calls[5].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[5].init?.body)), { sha: "newcommit", force: false });
  assert.deepEqual(result.structuredContent, {
    commit_sha: "newcommit",
    files_pushed: 1,
    files: ["README.md"],
    branch: "main",
    created_branch: false,
    based_on_parent: true,
    url: "https://github.com/grantry/hello/commit/newcommit",
  });
});

test("github/git_push_repo gives up after the retry cap on a persistent 429", async (t) => {
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  const waits: number[] = [];
  fastTimeout(waits);
  const calls = installFetchMock(({ url }) => {
    if (url === "https://api.github.com/repos/grantry/hello/git/ref/heads/main") {
      return jsonResponse({ object: { sha: "parent" } });
    }
    if (url === "https://api.github.com/repos/grantry/hello/git/commits/parent") {
      return jsonResponse({ message: "You have exceeded a secondary rate limit" }, { status: 429 });
    }
    return jsonResponse({ message: "Not Found" }, { status: 404 });
  });

  await assert.rejects(
    callGitHubTool(
      "github/git_push_repo",
      { owner: "grantry", repo: "hello", files: { "README.md": "# hi" } },
      "ghp_tok"
    ),
    (e: any) => {
      assert.match(String(e.message), /^git_push_repo GET \/commits\/parent failed: 429 /);
      assert.ok(String(e.message).includes("secondary rate limit"));
      return true;
    }
  );
  // 1 ref resolve + 6 commit fetches (attempts 0-5)
  assert.equal(calls.length, 7);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]); // exponential backoff, capped at 30s
});
