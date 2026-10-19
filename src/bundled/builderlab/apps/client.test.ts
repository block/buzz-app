import { expect, it, vi } from "vitest";
import type {
  Host,
  HostRequest,
  HostResponse,
  HostUpload,
} from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { createAppsClient } from "./client";
import { controlPlane, isAppUrl } from "./environment";

const BASE = "https://compose-ctrl.apps.builderlabstaging.xyz";
const json = (status: number, body: unknown): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});

async function setup(responses: HostResponse[], signedIn = true) {
  const session = createOAuthSession(async () => ({
    value: "secret-session",
    account: { subject: "auth0|owner", email: "" },
  }));
  if (signedIn) await session.signIn();
  const requests: (HostRequest | HostUpload)[] = [];
  const next = async (input: HostRequest | HostUpload) => {
    requests.push(input);
    const response = responses.shift();
    if (!response) throw new Error("No response left");
    return response;
  };
  const host = { request: vi.fn(next), upload: vi.fn(next) } as unknown as Host;
  return { client: createAppsClient(host, session, BASE), requests };
}

it("plans and reserves a static app with the Builderlab session", async () => {
  const { client, requests } = await setup([
    json(200, {
      app_id: "demo-1a2b",
      display_name: "Demo",
      environment: "production",
      initialize: { required: false, recommended: false },
      external_url: "https://demo-1a2b--bpsites.apps.builderlabstaging.xyz/",
    }),
    json(200, { ok: true, app_id: "demo-1a2b" }),
  ]);
  await expect(client.create("Demo")).resolves.toEqual({
    app_id: "demo-1a2b",
    external_url: "https://demo-1a2b--bpsites.apps.builderlabstaging.xyz/",
  });
  expect(requests).toMatchObject([
    {
      url: `${BASE}/v1/agent/apps/plan`,
      method: "POST",
      headers: {
        Authorization: "BBIdentity secret-session",
        "X-Hotpod-Agent-Client-Version": "0.2.0",
      },
    },
    { url: `${BASE}/v1/agent/apps/demo-1a2b/reserve`, method: "POST" },
  ]);
  const [plan, reserve] = requests as HostRequest[];
  expect(JSON.parse(plan?.body ?? "")).toEqual({
    name: "Demo",
    runtime_profile: "static",
    client_version: "0.2.0",
  });
  expect(JSON.parse(reserve?.body ?? "")).toEqual({
    environment: "production",
    name: "Demo",
  });
});

it("uploads the artifact to the app's deploy endpoint", async () => {
  const { client, requests } = await setup([
    json(200, { ok: true, version_id: "ver-1" }),
  ]);
  await expect(
    client.deploy("demo", "/Users/me/demo/artifact.tar.gz"),
  ).resolves.toEqual({ ok: true, version_id: "ver-1" });
  expect(requests).toEqual([
    {
      url: `${BASE}/v1/agent/apps/demo/deploy`,
      headers: {
        Accept: "application/json",
        Authorization: "BBIdentity secret-session",
        "X-Hotpod-Agent-Client-Version": "0.2.0",
      },
      file: {
        field: "artifact",
        path: "/Users/me/demo/artifact.tar.gz",
        name: "artifact.tar.gz",
        contentType: "application/gzip",
      },
    },
  ]);
});

it("points the agent at Settings when signed out or refused", async () => {
  const signedOut = await setup([], false);
  await expect(signedOut.client.list()).rejects.toThrow(
    /not signed in.*Settings → Integrations → Builderlab/,
  );
  expect(signedOut.requests).toEqual([]);
  const refused = await setup([json(401, {})]);
  await expect(refused.client.list()).rejects.toThrow(
    /refused the sign-in.*HTTP 401.*Settings/,
  );
});

it("reports the server's error without the session", async () => {
  const { client } = await setup([
    json(400, {
      error: {
        code: "artifact_manifest_invalid",
        message: "missing public/ for secret-session",
      },
      next_action: "rebuild",
    }),
  ]);
  const failure = client.deploy("demo", "/Users/me/artifact.tar.gz");
  await expect(failure).rejects.toThrow(
    "Deploying failed (HTTP 400): artifact_manifest_invalid: missing public/ for [redacted]: next_action: rebuild",
  );
});

it("shares only a restricted app, at its current grant revision", async () => {
  const { client, requests } = await setup([
    json(200, {
      visibility: "restricted",
      lifecycle_id: "life-1",
      workspace_grant_revision: 3,
    }),
    json(200, { ok: true }),
  ]);
  await client.share("demo", "team/one");
  expect(requests[1]).toMatchObject({
    url: `${BASE}/v1/agent/apps/demo/sharing/workspaces/team%2Fone`,
    method: "POST",
    body: JSON.stringify({ lifecycle_id: "life-1", expected_revision: 3 }),
  });
  const open = await setup([json(200, { visibility: "organization" })]);
  await expect(open.client.share("demo", "team")).rejects.toThrow(
    /restricted visibility/,
  );
});

it("deploys to the sign-in's own tenant and opens only its app hosts", () => {
  expect(controlPlane("https://app.builderlabstaging.xyz")).toBe(BASE);
  expect(controlPlane("https://block.builderlab.xyz/")).toBe(
    "https://compose-ctrl.block.builderlab.xyz",
  );
  expect(controlPlane("https://builderlab.example")).toBeUndefined();
  expect(controlPlane("")).toBeUndefined();
  for (const url of [
    "https://demo--bpsites.apps.block.builderlab.xyz/",
    "https://demo--bpsites.apps.builderlabstaging.xyz/path?x=1",
  ])
    expect(isAppUrl(url), url).toBe(true);
  for (const url of [
    "http://demo.apps.block.builderlab.xyz/",
    "https://apps.block.builderlab.xyz/",
    "https://demo.apps.block.builderlab.xyz.example.org/",
    "https://evilapps.block.builderlab.xyz/",
    "https://user:pass@demo.apps.block.builderlab.xyz/",
    "not a url",
  ])
    expect(isAppUrl(url), url).toBe(false);
});
