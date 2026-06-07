// Google Drive connector — OAuth access tokens.
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_TIMEOUT_MS = 10_000;

type DriveArgs = Record<string, unknown>;

function googleHeaders(token: string, accept = "application/json") {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
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

async function fetchDrive(url: string, init: RequestInit, logContext: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DRIVE_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[google_drive] request", { url, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[google_drive] response", { url, status: response.status, durationMs: Date.now() - started, ...logContext });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[google_drive] failed", {
      url,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${DRIVE_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`Google Drive request timed out after ${DRIVE_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

const DEFAULT_FILE_FIELDS = "files(id,name,mimeType,webViewLink,webContentLink,parents,createdTime,modifiedTime,size,owners(emailAddress,displayName)),nextPageToken";
const DEFAULT_GET_FIELDS = "id,name,mimeType,webViewLink,webContentLink,parents,createdTime,modifiedTime,size,owners(emailAddress,displayName)";

function pageSize(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 1000) : 100;
}

function fileId(args: DriveArgs) {
  const value = String(args.file_id ?? args.fileId ?? "").trim();
  if (!value) throw new Error("file_id is required");
  return value;
}

function encodeBase64(buffer: ArrayBuffer) {
  return Buffer.from(buffer).toString("base64");
}

export async function callGoogleDriveTool(tool: string, args: DriveArgs, token: string) {
  if (tool === "google_drive/list_files" || tool === "google_drive/search") {
    const url = new URL(`${DRIVE_API}/files`);
    const q = String(args.q ?? args.query ?? "").trim();
    if (q) url.searchParams.set("q", q);
    url.searchParams.set("pageSize", String(pageSize(args.page_size ?? args.pageSize)));
    url.searchParams.set("fields", String(args.fields ?? DEFAULT_FILE_FIELDS));
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    const pageToken = String(args.page_token ?? args.pageToken ?? "").trim();
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const orderBy = String(args.order_by ?? args.orderBy ?? "").trim();
    if (orderBy) url.searchParams.set("orderBy", orderBy);
    const corpora = String(args.corpora ?? "").trim();
    if (corpora) url.searchParams.set("corpora", corpora);
    const driveId = String(args.drive_id ?? args.driveId ?? "").trim();
    if (driveId) url.searchParams.set("driveId", driveId);

    const r = await fetchDrive(url.toString(), { headers: googleHeaders(token) }, { tool });
    const j: any = await readJsonResponse(r);
    if (!r.ok) throw new Error(`Google Drive ${tool.split("/")[1]} failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    return { structuredContent: { results: j.files ?? [], next_page_token: j.nextPageToken ?? null } };
  }

  if (tool === "google_drive/get_file") {
    const id = fileId(args);
    const exportMimeType = String(args.export_mime_type ?? args.exportMimeType ?? "").trim();
    const alt = String(args.alt ?? "").trim();

    if (exportMimeType) {
      const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(id)}/export`);
      url.searchParams.set("mimeType", exportMimeType);
      const r = await fetchDrive(url.toString(), { headers: googleHeaders(token, exportMimeType) }, { tool, fileId: id, exportMimeType });
      const contentType = r.headers.get("content-type") ?? exportMimeType;
      if (!r.ok) {
        const j: any = await readJsonResponse(r);
        throw new Error(`Google Drive export failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
      }
      const bytes = await r.arrayBuffer();
      return {
        structuredContent: {
          file_id: id,
          export_mime_type: exportMimeType,
          content_type: contentType,
          size: bytes.byteLength,
          content_base64: encodeBase64(bytes),
        },
      };
    }

    const metadataUrl = new URL(`${DRIVE_API}/files/${encodeURIComponent(id)}`);
    metadataUrl.searchParams.set("fields", String(args.fields ?? DEFAULT_GET_FIELDS));
    metadataUrl.searchParams.set("supportsAllDrives", "true");
    if (alt === "media" || args.download === true) metadataUrl.searchParams.set("alt", "media");

    const r = await fetchDrive(metadataUrl.toString(), { headers: googleHeaders(token, alt === "media" || args.download === true ? "*/*" : "application/json") }, { tool, fileId: id });
    if (!r.ok) {
      const j: any = await readJsonResponse(r);
      throw new Error(`Google Drive get_file failed: ${r.status} ${JSON.stringify(j).slice(0, 1000)}`);
    }

    if (alt === "media" || args.download === true) {
      const contentType = r.headers.get("content-type") ?? "application/octet-stream";
      const bytes = await r.arrayBuffer();
      return {
        structuredContent: {
          file_id: id,
          content_type: contentType,
          size: bytes.byteLength,
          content_base64: encodeBase64(bytes),
        },
      };
    }

    return { structuredContent: await r.json() };
  }

  throw new Error(`Unknown Google Drive tool: ${tool}`);
}
