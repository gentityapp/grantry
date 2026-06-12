// YouTube connector — YouTube Data API v3 using Google OAuth access tokens.
// Read tools (channels, videos, search, playlists) plus management tools
// (update video, create/update/delete playlist, add/remove playlist items).
// Management tools require the youtube.force-ssl scope.
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_TIMEOUT_MS = 10_000;

type YouTubeArgs = Record<string, unknown>;

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function readJsonResponse(r: Response) {
  const text = await r.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchYouTube(path: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YOUTUBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[youtube] request", { path, ...logContext });
    const response = await fetch(`${YOUTUBE_API}${path}`, { ...init, signal: controller.signal });
    console.log("[youtube] response", { path, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[youtube] failed", {
      path,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${YOUTUBE_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`YouTube request timed out after ${YOUTUBE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/** Build a comma-joined id list from a string ("a,b") or an array (["a","b"]). */
function idList(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join(",");
  return String(value ?? "").trim();
}

/** Comma-joined part string, falling back to the supplied default parts. */
function partString(value: unknown, fallback: string[]): string {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v).trim()).filter(Boolean)
    : String(value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return (parts.length ? parts : fallback).join(",");
}

function clampResults(value: unknown, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 50);
}

export async function callYouTubeTool(tool: string, args: YouTubeArgs, token: string) {
  const h = headers(token);

  if (tool === "youtube/list_channels") {
    const params = new URLSearchParams();
    params.set("part", partString(args.part, ["snippet", "contentDetails", "statistics"]));
    const id = idList(args.id ?? args.channel_id ?? args.channelId);
    const forUsername = String(args.for_username ?? args.forUsername ?? "").trim();
    if (id) params.set("id", id);
    else if (forUsername) params.set("forUsername", forUsername);
    else params.set("mine", "true");
    params.set("maxResults", String(clampResults(args.max_results ?? args.maxResults, 25)));
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetchYouTube(`/channels?${params.toString()}`, { headers: h }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube list_channels failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: { items: j.items ?? [], page_info: j.pageInfo ?? null, next_page_token: j.nextPageToken ?? null } };
  }

  if (tool === "youtube/list_videos") {
    const id = idList(args.id ?? args.video_id ?? args.videoId ?? args.ids);
    if (!id) throw new Error("id is required (one or more video ids)");
    const params = new URLSearchParams();
    params.set("part", partString(args.part, ["snippet", "contentDetails", "statistics", "status"]));
    params.set("id", id);
    params.set("maxResults", String(clampResults(args.max_results ?? args.maxResults, 50)));
    const r = await fetchYouTube(`/videos?${params.toString()}`, { headers: h }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube list_videos failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: { items: j.items ?? [], page_info: j.pageInfo ?? null } };
  }

  if (tool === "youtube/search") {
    const params = new URLSearchParams();
    params.set("part", "snippet");
    const q = String(args.q ?? args.query ?? "").trim();
    if (q) params.set("q", q);
    const type = String(args.type ?? "").trim();
    if (type) params.set("type", type);
    const channelId = String(args.channel_id ?? args.channelId ?? "").trim();
    if (channelId) params.set("channelId", channelId);
    const order = String(args.order ?? "").trim();
    if (order) params.set("order", order);
    if (args.mine === true || String(args.mine ?? "") === "true") params.set("forMine", "true");
    params.set("maxResults", String(clampResults(args.max_results ?? args.maxResults, 25)));
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetchYouTube(`/search?${params.toString()}`, { headers: h }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube search failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: { items: j.items ?? [], page_info: j.pageInfo ?? null, next_page_token: j.nextPageToken ?? null } };
  }

  if (tool === "youtube/list_playlists") {
    const params = new URLSearchParams();
    params.set("part", partString(args.part, ["snippet", "contentDetails", "status"]));
    const id = idList(args.id ?? args.playlist_id ?? args.playlistId);
    const channelId = String(args.channel_id ?? args.channelId ?? "").trim();
    if (id) params.set("id", id);
    else if (channelId) params.set("channelId", channelId);
    else params.set("mine", "true");
    params.set("maxResults", String(clampResults(args.max_results ?? args.maxResults, 25)));
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetchYouTube(`/playlists?${params.toString()}`, { headers: h }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube list_playlists failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: { items: j.items ?? [], page_info: j.pageInfo ?? null, next_page_token: j.nextPageToken ?? null } };
  }

  if (tool === "youtube/list_playlist_items") {
    const playlistId = String(args.playlist_id ?? args.playlistId ?? "").trim();
    if (!playlistId) throw new Error("playlist_id is required");
    const params = new URLSearchParams();
    params.set("part", partString(args.part, ["snippet", "contentDetails", "status"]));
    params.set("playlistId", playlistId);
    params.set("maxResults", String(clampResults(args.max_results ?? args.maxResults, 25)));
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetchYouTube(`/playlistItems?${params.toString()}`, { headers: h }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube list_playlist_items failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    return { structuredContent: { items: j.items ?? [], page_info: j.pageInfo ?? null, next_page_token: j.nextPageToken ?? null } };
  }

  if (tool === "youtube/update_video") {
    const id = String(args.id ?? args.video_id ?? args.videoId ?? "").trim();
    if (!id) throw new Error("id is required");
    const snippet = (args.snippet && typeof args.snippet === "object") ? { ...(args.snippet as Record<string, unknown>) } : undefined;
    const status = (args.status && typeof args.status === "object") ? (args.status as Record<string, unknown>) : undefined;
    if (!snippet && !status) throw new Error("provide a snippet and/or status object to update");
    const body: Record<string, unknown> = { id };
    const parts: string[] = [];
    if (snippet) {
      // The Videos.update endpoint requires categoryId when a snippet is sent.
      if (snippet.categoryId === undefined && snippet.category_id !== undefined) {
        snippet.categoryId = snippet.category_id;
        delete snippet.category_id;
      }
      if (snippet.categoryId === undefined) {
        throw new Error("snippet.categoryId is required when updating a video snippet");
      }
      body.snippet = snippet;
      parts.push("snippet");
    }
    if (status) {
      body.status = status;
      parts.push("status");
    }
    const params = new URLSearchParams({ part: parts.join(",") });
    const r = await fetchYouTube(`/videos?${params.toString()}`, { method: "PUT", headers: h, body: JSON.stringify(body) }, { tool, id });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube update_video failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "youtube/create_playlist") {
    const title = String(args.title ?? "").trim();
    if (!title) throw new Error("title is required");
    const snippet: Record<string, unknown> = { title };
    const description = args.description;
    if (description !== undefined) snippet.description = String(description);
    const tags = args.tags;
    if (Array.isArray(tags)) snippet.tags = tags.map((t) => String(t));
    const status: Record<string, unknown> = {};
    const privacy = String(args.privacy_status ?? args.privacyStatus ?? "private").trim();
    if (privacy) status.privacyStatus = privacy;
    const body = { snippet, status };
    const params = new URLSearchParams({ part: "snippet,status" });
    const r = await fetchYouTube(`/playlists?${params.toString()}`, { method: "POST", headers: h, body: JSON.stringify(body) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube create_playlist failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "youtube/update_playlist") {
    const id = String(args.id ?? args.playlist_id ?? args.playlistId ?? "").trim();
    if (!id) throw new Error("id is required");
    const title = String(args.title ?? "").trim();
    if (!title) throw new Error("title is required (the YouTube API replaces the playlist snippet on update)");
    const snippet: Record<string, unknown> = { title };
    const description = args.description;
    if (description !== undefined) snippet.description = String(description);
    const tags = args.tags;
    if (Array.isArray(tags)) snippet.tags = tags.map((t) => String(t));
    const body: Record<string, unknown> = { id, snippet };
    const parts = ["snippet"];
    const privacy = String(args.privacy_status ?? args.privacyStatus ?? "").trim();
    if (privacy) {
      body.status = { privacyStatus: privacy };
      parts.push("status");
    }
    const params = new URLSearchParams({ part: parts.join(",") });
    const r = await fetchYouTube(`/playlists?${params.toString()}`, { method: "PUT", headers: h, body: JSON.stringify(body) }, { tool, id });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube update_playlist failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "youtube/delete_playlist") {
    const id = String(args.id ?? args.playlist_id ?? args.playlistId ?? "").trim();
    if (!id) throw new Error("id is required");
    const params = new URLSearchParams({ id });
    const r = await fetchYouTube(`/playlists?${params.toString()}`, { method: "DELETE", headers: h }, { tool, id });
    if (!r.ok) {
      const j: any = await readJsonResponse(r);
      throw new Error(`YouTube delete_playlist failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    }
    return { structuredContent: { deleted: true, id } };
  }

  if (tool === "youtube/add_playlist_item") {
    const playlistId = String(args.playlist_id ?? args.playlistId ?? "").trim();
    const videoId = String(args.video_id ?? args.videoId ?? "").trim();
    if (!playlistId) throw new Error("playlist_id is required");
    if (!videoId) throw new Error("video_id is required");
    const snippet: Record<string, unknown> = {
      playlistId,
      resourceId: { kind: "youtube#video", videoId },
    };
    const position = args.position;
    if (position !== undefined && Number.isFinite(Number(position))) snippet.position = Math.max(Number(position), 0);
    const body = { snippet };
    const params = new URLSearchParams({ part: "snippet" });
    const r = await fetchYouTube(`/playlistItems?${params.toString()}`, { method: "POST", headers: h, body: JSON.stringify(body) }, { tool, playlistId, videoId });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`YouTube add_playlist_item failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: j };
  }

  if (tool === "youtube/delete_playlist_item") {
    const id = String(args.id ?? args.playlist_item_id ?? args.playlistItemId ?? "").trim();
    if (!id) throw new Error("id is required (the playlistItem id, not the video id)");
    const params = new URLSearchParams({ id });
    const r = await fetchYouTube(`/playlistItems?${params.toString()}`, { method: "DELETE", headers: h }, { tool, id });
    if (!r.ok) {
      const j: any = await readJsonResponse(r);
      throw new Error(`YouTube delete_playlist_item failed: ${r.status} ${JSON.stringify(j).slice(0, 800)}`);
    }
    return { structuredContent: { deleted: true, id } };
  }

  throw new Error(`Unknown YouTube tool: ${tool}`);
}
