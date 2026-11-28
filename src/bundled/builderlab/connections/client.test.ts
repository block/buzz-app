import { createTestSession } from "../test-helpers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createConnectionsClient } from "./client";

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const response = (body: unknown, status = 200): HostResponse => ({
  status,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});
async function fixture(reply: HostResponse) {
  const session = createTestSession(
    async () => ({
      revision: "secret",
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents: false,
        canUseBuilderlabDecisions: false,
        canUseHostedTranscription: false,
      },
    }),
    undefined,
    { request: (input) => host.request(input) },
  );
  await session.signIn();
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async () => reply),
  };
  return {
    host,
    client: createConnectionsClient(session),
    signal: new AbortController().signal,
  };
}
const json = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

it("lists connections with their end time and the ones the service dropped", async () => {
  const h = await fixture(
    response({
      extensions: [
        { name: "datadog", created: "1", expires_at_epoch_s: "1800000000" },
        { name: "slack", created: "1" },
        { name: "jira", created: "1", previously_connected: true },
      ],
    }),
  );
  expect(await h.client.list(h.signal)).toEqual({
    kind: "listed",
    connections: [
      { name: "datadog", expiresAt: 1_800_000_000_000, expired: false },
      { name: "slack", expired: false },
      { name: "jira", expired: true },
    ],
  });
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/list-oauth-extensions",
    method: "POST",
    headers: json,
    body: "{}",
  });
});

it("reads an omitted repeated field as no connections", async () => {
  const h = await fixture(response({}));
  expect(await h.client.list(h.signal)).toEqual({
    kind: "listed",
    connections: [],
  });
});

it("refuses a list it cannot read rather than reporting none", async () => {
  for (const body of ["<html>", { extensions: [{}] }, { extensions: 1 }]) {
    const h = await fixture(response(body));
    expect(await h.client.list(h.signal)).toEqual({
      kind: "invalid_response",
    });
  }
});

it("disconnects by extension name", async () => {
  const h = await fixture(response({}));
  expect(await h.client.disconnect("datadog", h.signal)).toEqual({
    kind: "accepted",
  });
  expect(h.host.request).toHaveBeenCalledWith({
    url: "https://builderlab.example/api/goose/delete-oauth-extension",
    method: "POST",
    headers: json,
    body: JSON.stringify({ extension: "datadog" }),
  });
});

it("reports a client error as a refusal and throws on a server error", async () => {
  const refused = await fixture(response("Forbidden", 403));
  expect(await refused.client.list(refused.signal)).toEqual({
    kind: "rejected",
    status: 403,
  });
  const failed = await fixture(response("Unavailable", 503));
  await expect(failed.client.list(failed.signal)).rejects.toThrow("HTTP 503");
});
