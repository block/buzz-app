import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Host } from "../../../features/host/service";
import { browserCredential, type BrowserBridge, oauthTarget } from "./browser";
import { deferred } from "../test-helpers";
beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => vi.unstubAllEnvs());

const attemptId = "native-attempt-id";
const account = {
  subject: "user",
  name: "A",
  email: "a@example.com",
  workspaces: { active: [{ name: "Block" }] },
};
function fixture() {
  const bridge: BrowserBridge = {
    begin: vi.fn(async ({ callbackPath }) => ({
      id: attemptId,
      callbackUrl: `http://127.0.0.1:12345${callbackPath}`,
    })),
    wait: vi.fn(async () => ({ parameters: [["code", "one-time"]] as const })),
    cancel: vi.fn(async () => {}),
  };
  const host: Host = {
    fetch: vi.fn(),
    runCommand: vi.fn(),
    request: vi.fn(async ({ url }) => ({
      status: 200,
      headers: {},
      body: JSON.stringify(
        url.endsWith("/exchange")
          ? { session_credential: "private-token" }
          : account,
      ),
    })),
  };
  return { host, bridge, controller: new AbortController() };
}
it("acquires a verified credential through the code-only callback", async () => {
  const origin = "https://builderlab.example";
  const { host, bridge, controller } = fixture();
  expect(await browserCredential(host, controller.signal, bridge)).toEqual({
    value: "private-token",
    account: { subject: "user", email: "a@example.com" },
  });
  const options = vi.mocked(bridge.begin).mock.calls[0]?.[0];
  expect(options).not.toHaveProperty("id");
  const login = new URL(options?.authorizationUrl ?? "");
  expect(login.origin).toBe(origin);
  expect(login.pathname).toBe("/api/goose/v1/auth/login");
  expect(Object.fromEntries(login.searchParams)).toEqual({
    type: "cli",
    product: "builderlab",
  });
  expect(options).toMatchObject({ useState: true });
  expect(options?.callbackPath).toMatch(/^\/callback\/[0-9a-f-]{36}$/);
  expect(host.request).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      url: `${origin}/api/goose/v1/auth/login/exchange`,
      method: "POST",
      body: '{"code":"one-time"}',
    }),
  );
  expect(host.request).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      url: `${origin}/api/goose/v1/auth/me`,
      headers: {
        Accept: "application/json",
        "X-BB-Session-Credential": "private-token",
      },
    }),
  );
  expect(bridge.wait).toHaveBeenCalledWith(attemptId);
  expect(bridge.cancel).toHaveBeenCalledWith(attemptId);
});

it.each(["", "x".repeat(4097)])(
  "refuses invalid one-time codes",
  async (code) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(bridge.wait).mockResolvedValue({ parameters: [["code", code]] });
    await expect(
      browserCredential(host, controller.signal, bridge),
    ).rejects.toThrow("callback code");
    expect(host.request).not.toHaveBeenCalled();
  },
);
describe("failed responses", () => {
  it.each([
    [401, '{"error":"private-detail"}'],
    [200, "{"],
    [200, '{"session_credential":""}'],
    [200, '{"session_credential":"bad\\nheader"}'],
    [200, '{"session_credential":"invalid-é"}'],
  ])(
    "rejects exchange HTTP %s without exposing its body",
    async (status, body) => {
      const { host, bridge, controller } = fixture();
      vi.mocked(host.request).mockResolvedValue({ status, headers: {}, body });
      const result = await browserCredential(
        host,
        controller.signal,
        bridge,
      ).catch((error: Error) => error);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).not.toContain("private-detail");
      expect(bridge.cancel).toHaveBeenCalled();
    },
  );
  it.each([null, { ...account, subject: " " }, { ...account, subject: 123 }])(
    "refuses an unverified account",
    async (value) => {
      const { host, bridge, controller } = fixture();
      vi.mocked(host.request)
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          body: '{"session_credential":"private-token"}',
        })
        .mockResolvedValueOnce({
          status: 200,
          headers: {},
          body: JSON.stringify(value),
        });
      await expect(
        browserCredential(host, controller.signal, bridge),
      ).rejects.toThrow("valid account");
    },
  );
});
it.each([
  [" a@example.com ", "a@example.com"],
  [undefined, ""],
  [123, ""],
])(
  "accepts an account without workspace data and keeps subject and email %j",
  async (email, expected) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(host.request)
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"session_credential":"private-token"}',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({
          subject: "user",
          email,
          name: "A",
          username: "a",
        }),
      });
    expect(await browserCredential(host, controller.signal, bridge)).toEqual({
      value: "private-token",
      account: { subject: "user", email: expected },
    });
  },
);
it("does not cancel an unknown attempt when begin rejects", async () => {
  const { host, bridge, controller } = fixture();
  vi.mocked(bridge.begin).mockRejectedValue("listener unavailable");
  await expect(
    browserCredential(host, controller.signal, bridge),
  ).rejects.toThrow("Could not complete");
  expect(bridge.cancel).not.toHaveBeenCalled();
  expect(host.request).not.toHaveBeenCalled();
});

it.each(["begin", "wait", "exchange", "account"] as const)(
  "cancellation during a held %s ignores its late result and closes the listener",
  async (boundary) => {
    const { host, bridge, controller } = fixture();
    const started = deferred<void>();
    const release = deferred<void>();
    if (boundary === "exchange" || boundary === "account") {
      vi.mocked(host.request).mockImplementation(async ({ url }) => {
        if (url.endsWith(boundary === "exchange" ? "/exchange" : "/auth/me")) {
          started.resolve();
          await release.promise;
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            url.endsWith("/exchange")
              ? { session_credential: "private-token" }
              : account,
          ),
        };
      });
    } else {
      vi.mocked(bridge[boundary]).mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return (
          boundary === "begin"
            ? { id: attemptId, callbackUrl: "http://127.0.0.1:12345/callback" }
            : boundary === "wait"
              ? { parameters: [["code", "one-time"]] }
              : undefined
        ) as never;
      });
    }
    const pending = browserCredential(host, controller.signal, bridge);
    try {
      await started.promise;
      controller.abort();
      if (boundary === "begin") expect(bridge.cancel).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await expect(pending).rejects.toThrow("canceled");
    expect(bridge.cancel).toHaveBeenCalledWith(attemptId);
    expect(bridge.wait).toHaveBeenCalledTimes(boundary === "begin" ? 0 : 1);
    expect(host.request).toHaveBeenCalledTimes(
      boundary === "account" ? 2 : boundary === "exchange" ? 1 : 0,
    );
  },
);

it("uses the configured public URL without a deployment default", async () => {
  expect(oauthTarget("https://builderlab.example/")).toBe(
    "https://builderlab.example/api/goose",
  );
  expect(oauthTarget("https://builderlab.example/deployment/")).toBe(
    "https://builderlab.example/deployment/api/goose",
  );
  expect(oauthTarget("https://login.example:8443/deployment/")).toBe(
    "https://login.example:8443/deployment/api/goose",
  );
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
  const { host, bridge, controller } = fixture();
  await expect(
    browserCredential(host, controller.signal, bridge),
  ).rejects.toThrow("not configured");
  expect(bridge.begin).not.toHaveBeenCalled();
  expect(host.request).not.toHaveBeenCalled();
});
it.each([
  "http://builderlab.example",
  "https://user:secret@builderlab.example",
  "https://builderlab.example/?query=x",
  "https://builderlab.example/#x",
])("refuses unsafe configuration %s", (value) => {
  expect(() => oauthTarget(value)).toThrow("does not support");
});

it.each([
  [
    ["error", "access_denied"],
    ["state", "private-state"],
    ["error_description", "private-detail"],
  ],
  [
    ["code", "one"],
    ["code", "two"],
  ],
] as const)(
  "rejects error or ambiguous callback parameters before exchange",
  async (...parameters) => {
    const { host, bridge, controller } = fixture();
    vi.mocked(bridge.wait).mockResolvedValue({ parameters });
    const result = await browserCredential(
      host,
      controller.signal,
      bridge,
    ).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String(result)).not.toContain("private-detail");
    expect(String(result)).not.toContain("private-state");
    expect(host.request).not.toHaveBeenCalled();
    expect(bridge.cancel).toHaveBeenCalled();
  },
);
