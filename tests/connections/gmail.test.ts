import assert from "node:assert/strict";
import { test } from "node:test";

import { callGmailTool, encodeMimeHeaderValue } from "../../src/connectors/gmail.js";

const originalFetch = globalThis.fetch;

function decodeRaw(raw: string) {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function decodeEncodedWords(value: string) {
  return value
    .split(/\s+/)
    .map((w) => {
      const m = w.match(/^=\?UTF-8\?B\?(.*)\?=$/);
      return m ? Buffer.from(m[1], "base64").toString("utf8") : w;
    })
    .join("");
}

test("ASCII-only header values are left as they are", () => {
  assert.equal(encodeMimeHeaderValue("Weekly report $28.7"), "Weekly report $28.7");
  assert.equal(encodeMimeHeaderValue(""), "");
});

test("non-ASCII header values become RFC 2047 encoded-words of at most 75 chars that decode back", () => {
  const subject = "ループ費用 9/18 23時台 $28.7（24時間平均 $23.5/時・1日換算 $563）";
  const encoded = encodeMimeHeaderValue(subject);
  assert.ok(/^[\x20-\x7e]+$/.test(encoded), "encoded value is ASCII only");
  for (const w of encoded.split(" ")) {
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(w.length <= 75, `encoded-word too long: ${w.length}`);
  }
  assert.equal(decodeEncodedWords(encoded), subject);
});

test("send_message puts an encoded Subject in the raw message and keeps the UTF-8 body", async () => {
  let captured = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    captured = String(init?.body ?? "");
    return new Response(JSON.stringify({ id: "m1", threadId: "t1" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const out: any = await callGmailTool(
      "gmail/send_message",
      { to: "sawai@rootteam.co.jp", subject: "ループ費用 9/18 23時台 $28.7", body: "直近 1 時間の請求額: $28.7\n" },
      "token",
    );
    assert.equal(out.structuredContent.id, "m1");
    const message = decodeRaw(JSON.parse(captured).raw);
    const [head, body] = message.split("\r\n\r\n");
    const subjectLine = head.split("\r\n").find((l) => l.startsWith("Subject: "))!;
    assert.match(subjectLine, /^Subject: =\?UTF-8\?B\?/);
    assert.equal(decodeEncodedWords(subjectLine.slice("Subject: ".length)), "ループ費用 9/18 23時台 $28.7");
    assert.ok(head.includes("MIME-Version: 1.0"));
    assert.ok(head.includes("Content-Type: text/plain; charset=UTF-8"));
    assert.equal(body, "直近 1 時間の請求額: $28.7\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
