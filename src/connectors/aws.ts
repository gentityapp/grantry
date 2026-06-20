// AWS connector — AWS Signature Version 4 (SigV4) authentication.
// Credential JSON: { accessKeyId, secretAccessKey, region?, sessionToken? }
// region defaults to "us-east-1". sessionToken is optional (for temporary credentials / assumed roles).
import { createHash, createHmac } from "node:crypto";

const AWS_TIMEOUT_MS = 12_000;

type AwsArgs = Record<string, unknown>;

type AwsCredential = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  sessionToken?: string;
};

export function parseAwsCredential(credential: string): AwsCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("AWS credential is empty");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("AWS credential must be a JSON object");
  }
  const accessKeyId = String(parsed.accessKeyId ?? "").trim();
  if (!accessKeyId) throw new Error("AWS credential JSON must include accessKeyId");
  const secretAccessKey = String(parsed.secretAccessKey ?? "").trim();
  if (!secretAccessKey) throw new Error("AWS credential JSON must include secretAccessKey");
  const region = String(parsed.region ?? "us-east-1").trim() || "us-east-1";
  const sessionToken = parsed.sessionToken ? String(parsed.sessionToken).trim() : undefined;
  return { accessKeyId, secretAccessKey, region, sessionToken: sessionToken || undefined };
}

// ---------------------------------------------------------------------------
// SigV4 signer
// ---------------------------------------------------------------------------

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  return kSigning;
}

type SigV4Params = {
  method: string;
  service: string;
  region: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body: string;
  credential: AwsCredential;
};

/**
 * Compute and return all headers needed for AWS SigV4 auth, merged with provided headers.
 * Modifies the passed headers in-place and also returns them for convenience.
 */
function signRequest(params: SigV4Params): Record<string, string> {
  const { method, service, region, host, path, query = "", body, credential } = params;
  const now = new Date();
  // Format: YYYYMMDDTHHMMSSZ
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").replace("Z", "Z").slice(0, 16) + "00Z";
  const dateStamp = amzDate.slice(0, 8);

  // Build headers (must include host and x-amz-date)
  const allHeaders: Record<string, string> = {
    ...params.headers,
    host,
    "x-amz-date": amzDate,
  };
  if (credential.sessionToken) {
    allHeaders["x-amz-security-token"] = credential.sessionToken;
  }

  // Canonical headers: lowercase key, trim value, sort by key
  const canonicalHeaderMap = Object.fromEntries(
    Object.entries(allHeaders).map(([key, value]) => [key.toLowerCase(), String(value).trim()]),
  );
  const sortedHeaderKeys = Object.keys(canonicalHeaderMap).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${canonicalHeaderMap[k]}`)
    .join("\n") + "\n";
  const signedHeaders = sortedHeaderKeys.join(";");

  const payloadHash = sha256Hex(body);

  const canonicalUri = path || "/";
  const canonicalQueryString = query;

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(credential.secretAccessKey, dateStamp, region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  allHeaders["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return allHeaders;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchAws(
  url: string,
  init: RequestInit,
  logContext: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AWS_TIMEOUT_MS);
  const started = Date.now();
  const shortUrl = url.replace(/https?:\/\/[^/]+/, "");
  try {
    console.log("[aws] request", { url, ...logContext });
    const response = await fetch(url, { ...init, signal: controller.signal });
    console.log("[aws] response", {
      url: shortUrl,
      status: response.status,
      durationMs: Date.now() - started,
      ...logContext,
    });
    return response;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[aws] failed", {
      url: shortUrl,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${AWS_TIMEOUT_MS}ms` : String(e?.message ?? e),
      ...logContext,
    });
    if (aborted) throw new Error(`AWS request timed out after ${AWS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// XML helpers (regex-based, no DOM dependency)
// ---------------------------------------------------------------------------

function xmlExtract(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`));
  return m?.[1]?.trim();
}

function xmlExtractAll(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1].trim();
    if (val) results.push(val);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function callAwsTool(tool: string, args: AwsArgs, credential: string) {
  const cred = parseAwsCredential(credential);
  const { region } = cred;

  if (tool === "aws/get_caller_identity") {
    const service = "sts";
    const host = `sts.${region}.amazonaws.com`;
    const url = `https://${host}/`;
    const body = "Action=GetCallerIdentity&Version=2011-06-15";
    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const signedHeaders = signRequest({
      method: "POST",
      service,
      region,
      host,
      path: "/",
      query: "",
      headers: baseHeaders,
      body,
      credential: cred,
    });
    const r = await fetchAws(url, { method: "POST", headers: signedHeaders, body }, { tool });
    const text = await r.text();
    if (!r.ok) throw new Error(`AWS get_caller_identity failed: ${r.status} ${text.slice(0, 1000)}`);
    const account = xmlExtract(text, "Account");
    const arn = xmlExtract(text, "Arn");
    const userId = xmlExtract(text, "UserId");
    return {
      structuredContent: {
        Account: account,
        Arn: arn,
        UserId: userId,
        xml: text,
      },
    };
  }

  if (tool === "aws/s3_list_buckets") {
    const service = "s3";
    const host = `s3.${region}.amazonaws.com`;
    const url = `https://${host}/`;
    const body = "";
    const baseHeaders: Record<string, string> = {};
    const signedHeaders = signRequest({
      method: "GET",
      service,
      region,
      host,
      path: "/",
      query: "",
      headers: baseHeaders,
      body,
      credential: cred,
    });
    const r = await fetchAws(url, { method: "GET", headers: signedHeaders }, { tool });
    const text = await r.text();
    if (!r.ok) throw new Error(`AWS s3_list_buckets failed: ${r.status} ${text.slice(0, 1000)}`);
    const buckets = xmlExtractAll(text, "Name");
    return {
      structuredContent: {
        buckets,
        xml: text,
      },
    };
  }

  if (tool === "aws/s3_list_objects") {
    const bucket = String(args.bucket ?? "").trim();
    if (!bucket) throw new Error("bucket is required");
    const service = "s3";
    const host = `s3.${region}.amazonaws.com`;
    const path = `/${encodeURIComponent(bucket)}`;
    const query = "list-type=2";
    const url = `https://${host}${path}?${query}`;
    const body = "";
    const baseHeaders: Record<string, string> = {};
    const signedHeaders = signRequest({
      method: "GET",
      service,
      region,
      host,
      path,
      query,
      headers: baseHeaders,
      body,
      credential: cred,
    });
    const r = await fetchAws(url, { method: "GET", headers: signedHeaders }, { tool, bucket });
    const text = await r.text();
    if (!r.ok) throw new Error(`AWS s3_list_objects failed: ${r.status} ${text.slice(0, 1000)}`);
    const keys = xmlExtractAll(text, "Key");
    return {
      structuredContent: {
        bucket,
        keys,
        xml: text,
      },
    };
  }

  throw new Error(`Unknown AWS tool: ${tool}`);
}
