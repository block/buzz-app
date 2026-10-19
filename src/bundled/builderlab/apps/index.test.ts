import { afterEach, expect, it, vi } from "vitest";
import type { AddedTool } from "../../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../../buzz-mcp/client";
import type { HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { applyApps } from "./index";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const json = (body: unknown): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});
const APP = "https://demo--bpsites.apps.builderlabstaging.xyz/";

async function setup(url = "https://app.builderlabstaging.xyz") {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", url);
  const session = createOAuthSession(async () => ({
    value: "session",
    account: { subject: "auth0|owner", email: "" },
  }));
  await session.signIn();
  const tools = new Map<string, AddedTool>();
  const responses: HostResponse[] = [];
  const respond = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("No response left");
    return next;
  });
  const ctx = {
    panels: { register: vi.fn(), requestOpen: vi.fn(() => true) },
    browser: { available: true, View: () => null },
    host: { request: respond, upload: respond },
    agents: { addTool: (tool: AddedTool) => tools.set(tool.name, tool) },
  };
  applyApps(ctx as never, session);
  const call = (name: string, args: Record<string, unknown>, context = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No tool ${name}`);
    return tool.call({} as BuzzClient, context, args);
  };
  return { ctx, tools, responses, respond, call };
}

it("adds the app tools only for a tenant with an Apps control plane", async () => {
  expect([...(await setup()).tools.keys()]).toEqual([
    "apps_create",
    "apps_deploy",
    "apps_list",
    "apps_share",
    "apps_open",
  ]);
  const other = await setup("https://builderlab.example");
  expect(other.tools.size).toBe(0);
  // The panel opens app links whatever the sign-in.
  expect(other.ctx.panels.register).toHaveBeenCalledWith(
    expect.objectContaining({ id: "app", title: "App" }),
  );
});

it("returns once the deployed version serves", async () => {
  vi.useFakeTimers();
  const { call, responses, respond } = await setup();
  responses.push(
    json({ ok: true, version_id: "ver-1", external_url: APP }),
    json({ ready: false }),
    json({ ready: true }),
  );
  const deployed = call("apps_deploy", {
    app_id: "demo",
    artifact: "/Users/me/demo/artifact.tar.gz",
  });
  await vi.advanceTimersByTimeAsync(3_000);
  await expect(
    deployed.then((text) => JSON.parse(String(text))),
  ).resolves.toEqual({
    app_id: "demo",
    version_id: "ver-1",
    external_url: APP,
    ready: true,
  });
  expect(respond).toHaveBeenCalledTimes(3);
});

it("opens an app beside the conversation the agent works in", async () => {
  const { call, ctx } = await setup();
  await expect(
    call("apps_open", { url: APP }, { channel: "c1", root: "r1" }),
  ).resolves.toBe("Opened beside the conversation.");
  expect(ctx.panels.requestOpen).toHaveBeenCalledWith({
    target: APP,
    channelId: "c1",
    rootId: "r1",
  });
  ctx.panels.requestOpen.mockReturnValue(false);
  await expect(
    call("apps_open", { url: APP }, { channel: "c1" }),
  ).resolves.toMatch(/^Not opened/);
  await expect(
    call("apps_open", { url: "https://example.org/" }, { channel: "c1" }),
  ).rejects.toThrow(/not a Builderlab app URL/);
});
