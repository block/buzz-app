import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FederatedIdentityService } from "../../../features/federated-identity/service";
import { federatedFixture } from "../../../features/federated-identity/testing";
import type { StorageResult } from "../../../plugins/types";
import manifest from "../manifest.json";
import {
  bundledFederatedIdentity,
  bundledHost,
  firstRunCredential,
} from "./first-run";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const catalog = (enabled: boolean): StorageResult => ({
  status: "ready",
  catalog: {
    profile: "default",
    location: "/profiles/default",
    plugins: [
      {
        manifest: { ...manifest, apiVersion: 1 },
        source: "bundled",
        revision: "bundled",
        enabled,
        previous: null,
        reloadable: false,
        error: null,
      },
    ],
  },
  externalPluginsPaused: false,
});

it("requests under the bundled Builderlab grant without a plugin owner", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: "{}",
  });
  const request = { url: "https://app.builderlab.xyz/api/goose/v1/auth/me" };
  await bundledHost.request(request);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "block.builderlab",
    revision: "bundled",
    request,
  });
  expect(await bundledHost.runCommand("any")).toBeNull();
});

it("starts the native browser handoff at the configured build URL", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
  // A refused listener ends the attempt before any exchange request.
  vi.mocked(invoke).mockRejectedValueOnce("listener unavailable");
  await expect(
    firstRunCredential(new AbortController().signal),
  ).rejects.toThrow("Could not complete");
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenNthCalledWith(1, "plugin_catalog");
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    "oauth_callback_begin",
    expect.objectContaining({
      authorizationUrl: expect.stringMatching(
        /^https:\/\/builderlab\.example\/api\/goose\/v1\/auth\/login\?/,
      ),
      useState: true,
    }),
  );
});

// A disabled bundled plugin has no native grant, so its code exchange fails.
it.each([
  [
    "Builderlab is turned off",
    () => vi.mocked(invoke).mockResolvedValueOnce(catalog(false)),
    "Builderlab is turned off on this device, so you can't sign in with email. Enter a community address instead.",
  ],
  [
    "the plugin catalog cannot be read",
    () => vi.mocked(invoke).mockRejectedValueOnce("Plugin manager unavailable"),
    "Could not complete Builderlab sign-in. Try again.",
  ],
])(
  "refuses before opening the browser when %s",
  async (_label, answer, message) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
    answer();
    await expect(
      firstRunCredential(new AbortController().signal),
    ).rejects.toThrow(new Error(message));
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin_catalog"]]);
  },
);

describe("an FI build", () => {
  const me = {
    subject: "user",
    email: " a@example.com ",
    capabilities: { can_use_remote_agents: true },
  };

  it("calls the NIP-FI forwarder as the bundled installation, before the plugin starts", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "federated_identity_snapshot")
        return { ...federatedFixture().service.snapshot(), revision: "r" };
      if (command === "federated_identity_request")
        return { status: 200, headers: {}, body: "{}" };
    });
    const root = new Context();
    new FederatedIdentityService(root);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("federated_identity_snapshot"),
    );
    const request = { path: "/api/goose/v1/auth/me", method: "GET" as const };
    await bundledFederatedIdentity(root).request(request);
    expect(invoke).toHaveBeenCalledWith("federated_identity_register", {
      id: "block.builderlab",
      revision: "bundled",
      registration: expect.any(String),
    });
    expect(invoke).toHaveBeenCalledWith("federated_identity_request", {
      id: "block.builderlab",
      revision: "bundled",
      registration: expect.any(String),
      session: "r",
      request,
    });
    await root.fiber.dispose();
  });

  it("signs in through the native session and reads its account, never opening the plugin's own browser handoff", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    fi.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify(me),
    });
    const credential = await firstRunCredential(
      new AbortController().signal,
      fi.service,
    );
    expect(credential).toEqual({
      value: fi.service.snapshot().revision,
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    });
    expect(fi.service.signIn).toHaveBeenCalledOnce();
    expect(fi.request.mock.calls).toEqual([
      [
        {
          path: "/api/goose/v1/auth/me",
          method: "GET",
          headers: { Accept: "application/json" },
        },
      ],
    ]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["plugin_catalog"]]);
  });

  it.each([
    [
      "the native sign-in did not finish",
      (fi: ReturnType<typeof federatedFixture>) =>
        vi.mocked(fi.service.signIn).mockImplementationOnce(async () => ({
          ...fi.service.snapshot(),
          failure: "sign-in-canceled",
        })),
      "Sign-in was canceled. Sign in when you’re ready.",
    ],
    [
      "a renewal of the existing session does not finish",
      (fi: ReturnType<typeof federatedFixture>) => {
        fi.publish({ status: "signed-in", revision: "existing" });
        vi.mocked(fi.service.signIn).mockImplementationOnce(async () =>
          fi.service.snapshot(),
        );
      },
      "Sign-in was canceled. Sign in when you’re ready.",
    ],
    [
      "native refuses the sign-in with a failure code",
      (fi: ReturnType<typeof federatedFixture>) =>
        vi
          .mocked(fi.service.signIn)
          .mockRejectedValueOnce(new Error("login-refused")),
      "Sign-in did not finish. Try again.",
    ],
    [
      "the account read is not JSON",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockResolvedValueOnce({
          status: 200,
          headers: {},
          body: "<html>",
        }),
      "Could not load your Builderlab account. Try again.",
    ],
    [
      "the account read is refused",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockResolvedValueOnce({
          status: 403,
          headers: {},
          body: "",
        }),
      "Could not load your Builderlab account. Try again.",
    ],
    [
      "the session changes during the account read",
      (fi: ReturnType<typeof federatedFixture>) =>
        fi.request.mockImplementationOnce(async () => {
          fi.publish({ revision: "replaced" });
          return { status: 200, headers: {}, body: JSON.stringify(me) };
        }),
      "Could not load your Builderlab account. Try again.",
    ],
  ])("fails when %s", async (_label, arrange, message) => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    arrange(fi);
    await expect(
      firstRunCredential(new AbortController().signal, fi.service),
    ).rejects.toThrow(new Error(message));
  });

  it("cancels the native sign-in when first run cancels", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(catalog(true));
    const fi = federatedFixture();
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(fi.service.signIn).mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) =>
        vi
          .mocked(fi.service.cancelSignIn)
          .mockImplementationOnce(async () => resolve()),
      );
      return fi.service.snapshot();
    });
    const attempt = new AbortController();
    const credential = firstRunCredential(attempt.signal, fi.service);
    await pending;
    attempt.abort();
    await expect(credential).rejects.toThrow("Sign-in canceled.");
    expect(fi.service.cancelSignIn).toHaveBeenCalledOnce();
    expect(fi.request).not.toHaveBeenCalled();
  });
});
