import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { joinedCommunities } from "./communities";

const reply = (status: number, body: unknown): HostResponse => ({
  status,
  headers: {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://app.builderlabstaging.xyz"),
);
afterEach(() => vi.unstubAllEnvs());

async function signedIn(response: HostResponse) {
  const request = vi.fn(async (_: HostRequest) => response);
  const session = createOAuthSession(
    async () => ({
      value: "secret",
      account: {
        subject: "auth0|owner",
        email: "",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request },
  );
  await session.signIn();
  return { session, request };
}

it("lists joined communities by ID, name and device relay address", async () => {
  const { session, request } = await signedIn(
    reply(200, {
      communities: [
        { id: "c1", name: "Alpha", normalized_host: "Alpha.Example.com" },
        { id: "c2", normalizedHost: "wss://beta.example.com" },
        { id: "", name: "No ID", normalized_host: "x.example.com" },
        { id: "c3", name: "No host" },
        null,
      ],
    }),
  );
  await expect(joinedCommunities(session)).resolves.toEqual([
    { id: "c1", name: "Alpha", address: "wss://alpha.example.com" },
    { id: "c2", name: "beta.example.com", address: "wss://beta.example.com" },
  ]);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      url: expect.stringMatching(/\/v1\/buzz\/joined-communities\/list$/),
      method: "POST",
      body: "{}",
    }),
  );
});

it("ends an expired sign-in and reports refusals and bad bodies", async () => {
  const expired = await signedIn(reply(401, ""));
  await expect(joinedCommunities(expired.session)).rejects.toThrow(/HTTP 401/);
  expect(expired.session.snapshot().status).toBe("signed-out");
  await expect(joinedCommunities(expired.session)).rejects.toThrow(
    /not signed in/,
  );

  const broken = await signedIn(reply(200, "not json"));
  await expect(joinedCommunities(broken.session)).rejects.toThrow(/invalid/);
  const shapeless = await signedIn(reply(200, { communities: {} }));
  await expect(joinedCommunities(shapeless.session)).rejects.toThrow(/invalid/);
});
