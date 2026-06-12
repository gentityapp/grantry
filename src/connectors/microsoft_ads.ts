// Microsoft Advertising (Bing Ads) connector — SOAP 1.1 over HTTPS.
//
// IMPORTANT: Microsoft Advertising does NOT have a clean REST API for most operations.
// This connector implements a minimal SOAP client targeting the Customer Management
// Service v13. Only two operations are currently implemented:
//   - microsoft_ads/get_user      → GetUser
//   - microsoft_ads/get_accounts_info → GetAccountsInfo
//
// The SOAP envelope is hand-built as a string — no XML library dependency.
// access_token is a short-lived OAuth2 Bearer token and must be refreshed externally
// (e.g. via Microsoft identity platform refresh_token flow) before it expires.

const MSADS_TIMEOUT_MS = 12_000;
const MSADS_CM_ENDPOINT =
  "https://clientcenter.api.bingads.microsoft.com/Api/CustomerManagement/v13/CustomerManagementService.svc";
const MSADS_CM_NS = "https://bingads.microsoft.com/Customer/v13";

type MsAdsArgs = Record<string, unknown>;

type MsAdsCredential = {
  developer_token: string;
  access_token: string;
  customer_id?: string;
  account_id?: string;
};

export function parseMicrosoftAdsCredential(credential: string): MsAdsCredential {
  const trimmed = credential.trim();
  if (!trimmed) throw new Error("Microsoft Ads credential is empty");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Microsoft Ads credential must be a JSON object");
  }
  const developer_token = String(parsed.developer_token ?? "").trim();
  if (!developer_token) throw new Error("Microsoft Ads credential JSON must include developer_token");
  const access_token = String(parsed.access_token ?? "").trim();
  if (!access_token) throw new Error("Microsoft Ads credential JSON must include access_token");
  const customer_id = parsed.customer_id ? String(parsed.customer_id).trim() : undefined;
  const account_id = parsed.account_id ? String(parsed.account_id).trim() : undefined;
  return {
    developer_token,
    access_token,
    customer_id: customer_id || undefined,
    account_id: account_id || undefined,
  };
}

function buildSoapEnvelope(cred: MsAdsCredential, bodyContent: string): string {
  const headerParts: string[] = [
    `<DeveloperToken xmlns="${MSADS_CM_NS}">${escapeXml(cred.developer_token)}</DeveloperToken>`,
    `<AuthenticationToken xmlns="${MSADS_CM_NS}">${escapeXml(cred.access_token)}</AuthenticationToken>`,
  ];
  if (cred.customer_id) {
    headerParts.push(`<CustomerId xmlns="${MSADS_CM_NS}">${escapeXml(cred.customer_id)}</CustomerId>`);
  }
  if (cred.account_id) {
    headerParts.push(`<CustomerAccountId xmlns="${MSADS_CM_NS}">${escapeXml(cred.account_id)}</CustomerAccountId>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <s:Header>
    ${headerParts.join("\n    ")}
  </s:Header>
  <s:Body>
    ${bodyContent}
  </s:Body>
</s:Envelope>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function postSoap(
  soapAction: string,
  envelope: string,
  tool: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MSADS_TIMEOUT_MS);
  const started = Date.now();
  try {
    console.log("[microsoft_ads] request", { tool, soapAction });
    const response = await fetch(MSADS_CM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: soapAction,
      },
      body: envelope,
      signal: controller.signal,
    });
    console.log("[microsoft_ads] response", {
      tool,
      soapAction,
      status: response.status,
      durationMs: Date.now() - started,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Microsoft Ads ${tool} failed: ${response.status} ${text.slice(0, 1000)}`);
    }
    return text;
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    console.error("[microsoft_ads] failed", {
      tool,
      soapAction,
      durationMs: Date.now() - started,
      error: aborted ? `timeout after ${MSADS_TIMEOUT_MS}ms` : String(e?.message ?? e),
    });
    if (aborted) throw new Error(`Microsoft Ads request timed out after ${MSADS_TIMEOUT_MS}ms`);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function xmlExtract(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([^<]*)<\/(?:[^:>]+:)?${tag}>`));
  return m?.[1]?.trim();
}

function xmlExtractAll(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<(?:[^:>]+:)?${tag}[^>]*>([^<]*)<\/(?:[^:>]+:)?${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1].trim();
    if (val) results.push(val);
  }
  return results;
}

export async function callMicrosoftAdsTool(tool: string, args: MsAdsArgs, credential: string) {
  const cred = parseMicrosoftAdsCredential(credential);

  if (tool === "microsoft_ads/get_user") {
    const bodyContent = `<GetUserRequest xmlns="${MSADS_CM_NS}"><UserId i:nil="true" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"/></GetUserRequest>`;
    const envelope = buildSoapEnvelope(cred, bodyContent);
    const xml = await postSoap("GetUser", envelope, tool);
    const userName = xmlExtract(xml, "UserName");
    const id = xmlExtract(xml, "Id");
    return {
      structuredContent: {
        UserName: userName,
        Id: id,
        xml,
      },
    };
  }

  if (tool === "microsoft_ads/get_accounts_info") {
    const customerId = String(args.customer_id ?? cred.customer_id ?? "").trim();
    if (!customerId) throw new Error("customer_id is required (either as argument or in credential)");
    const bodyContent = `<GetAccountsInfoRequest xmlns="${MSADS_CM_NS}"><CustomerId>${escapeXml(customerId)}</CustomerId><OnlyParentAccounts>false</OnlyParentAccounts></GetAccountsInfoRequest>`;
    const envelope = buildSoapEnvelope(cred, bodyContent);
    const xml = await postSoap("GetAccountsInfo", envelope, tool);
    const ids = xmlExtractAll(xml, "Id");
    const names = xmlExtractAll(xml, "Name");
    const accounts = ids.map((id, i) => ({ Id: id, Name: names[i] ?? null }));
    return {
      structuredContent: {
        accounts,
        xml,
      },
    };
  }

  throw new Error(`Unknown Microsoft Ads tool: ${tool}`);
}
