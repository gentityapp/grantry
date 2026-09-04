import assert from "node:assert/strict";
import { test } from "node:test";

import { callMicrosoftTeamsTool } from "../../src/connectors/microsoft_teams.js";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const originalFetch = globalThis.fetch;

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

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("Microsoft Teams connector lists joined teams and channels", async (t) => {
  const calls = installFetchMock(({ url }) => {
    if (url === "https://graph.microsoft.com/v1.0/me/joinedTeams") {
      return jsonResponse({ value: [{ id: "team-1", displayName: "Root" }] });
    }
    if (url === "https://graph.microsoft.com/v1.0/teams/team-1/channels") {
      return jsonResponse({ value: [{ id: "channel-1", displayName: "General" }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  t.after(restoreFetch);

  const teams = await callMicrosoftTeamsTool("microsoft_teams/list_joined_teams", {}, "token");
  const channels = await callMicrosoftTeamsTool("microsoft_teams/list_channels", { team_id: "team-1" }, "token");

  assert.deepEqual((teams.structuredContent as any).value[0].displayName, "Root");
  assert.deepEqual((channels.structuredContent as any).value[0].displayName, "General");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer token");
});

test("Microsoft Teams connector reads messages and sends channel replies", async (t) => {
  const calls = installFetchMock((call) => {
    if (call.url === "https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages?%24top=10") {
      return jsonResponse({ value: [{ id: "message-1", body: { content: "hello" } }] });
    }
    if (call.url === "https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages/message-1/replies") {
      assert.equal(call.init?.method, "POST");
      assert.deepEqual(JSON.parse(String(call.init?.body)), { body: { contentType: "text", content: "了解" } });
      return jsonResponse({ id: "reply-1" }, { status: 201 });
    }
    throw new Error(`unexpected fetch ${call.url}`);
  });
  t.after(restoreFetch);

  const messages = await callMicrosoftTeamsTool("microsoft_teams/list_messages", { team_id: "team-1", channel_id: "channel-1", top: 10 }, "token");
  const reply = await callMicrosoftTeamsTool("microsoft_teams/send_reply", { team_id: "team-1", channel_id: "channel-1", message_id: "message-1", content: "了解" }, "token");

  assert.equal((messages.structuredContent as any).value[0].id, "message-1");
  assert.equal((reply.structuredContent as any).id, "reply-1");
  assert.equal(calls.length, 2);
});
