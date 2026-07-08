import { PROVIDERS } from "../src/connectors/registry.js";

const EXPLICIT_NON_GENERIC_PROVIDERS: Record<string, string> = {
  grantry: "internal Grantry admin provider; use dedicated admin MCP tools, not provider API passthrough",
  aws: "AWS raw passthrough requires SigV4 signing from method/service/region/host/path/body, not plain provider/request",
  microsoft_ads: "Microsoft Ads is SOAP-based and requires generated SOAP envelopes with credential headers",
  cloudsign: "CloudSign stores a Web API client_id and exchanges it for short-lived access tokens through its dedicated connector",
};

const REQUIRED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const errors: string[] = [];

for (const provider of Object.values(PROVIDERS)) {
  if (provider.implemented === false) continue;

  const generic = provider.genericRequest;
  if (!generic) {
    if (!EXPLICIT_NON_GENERIC_PROVIDERS[provider.key]) {
      errors.push(`${provider.key}: missing generic provider/request coverage`);
    }
    continue;
  }

  for (const suffix of ["request", "check_connection", "list_capabilities"]) {
    const tool = `${provider.key}/${suffix}`;
    if (!provider.tools.includes(tool)) {
      errors.push(`${provider.key}: genericRequest is configured but ${tool} is not exposed`);
    }
  }

  const methods = new Set((generic.defaultMethods ?? []).map((method) => method.toUpperCase()));
  for (const method of REQUIRED_METHODS) {
    if (!methods.has(method)) {
      errors.push(`${provider.key}: ${provider.key}/request must allow ${method} to avoid silently narrowing provider API access`);
    }
  }

  if (!generic.allowedPathPrefixes?.length) {
    errors.push(`${provider.key}: genericRequest must declare allowedPathPrefixes`);
  }
}

for (const key of Object.keys(EXPLICIT_NON_GENERIC_PROVIDERS)) {
  const provider = PROVIDERS[key];
  if (!provider || provider.implemented === false) continue;
  if (provider.genericRequest) {
    errors.push(`${key}: remove explicit non-generic exception after adding genericRequest coverage`);
  }
}

if (errors.length) {
  console.error("Provider request coverage audit failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Provider request coverage audit passed");
