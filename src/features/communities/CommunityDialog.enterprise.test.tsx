// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  EnterpriseDiscoveryError,
  EnterpriseLoginRequired,
  type Communities,
} from "./service";
import { CommunityDialog } from "./CommunityDialog";

const api = vi.hoisted(() => ({
  communityRequest: vi.fn(),
  inspectProfile: vi.fn(),
  publishProfile: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
vi.mock("../identity/service", async (actual) => ({
  ...(await actual<typeof import("../identity/service")>()),
  nativeIdentityEnabled: () => true,
}));
vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  communityRequest: api.communityRequest,
  inspectProfile: api.inspectProfile,
  publishProfile: api.publishProfile,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("enters access on a required destination gate without admitting first", async () => {
  const community = "https://enterprise.example";
  const calls: string[] = [];
  api.communityRequest.mockImplementation(
    async (_id: string, route: string) => {
      calls.push(route);
      if (route === "info") return { name: "Enterprise", policy: null };
      throw new Error(`unexpected admission route: ${route}`);
    },
  );
  api.inspectProfile.mockRejectedValue(new EnterpriseLoginRequired(community));
  const connect = vi.fn(async () => {
    throw new EnterpriseLoginRequired(community);
  });
  const snapshot = {
    status: "ready",
    relayAvailable: true,
    viewer: "a".repeat(64),
    selected: null,
    memberships: [],
    profile: { name: "Local", picture: "" },
    enterprise: {
      communityId: community,
      status: "required" as const,
    },
  } as const;
  const communities = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    connect,
    dismissEnterpriseLogin: vi.fn(),
    cancelEnterpriseLogin: vi.fn(),
    startEnterpriseLogin: vi.fn(),
    retryEnterpriseGate: vi.fn(),
    joined: vi.fn(),
  } as unknown as Communities;
  const user = userEvent.setup();
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );

  await user.type(screen.getByLabelText("Relay URL"), community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText(/requires enterprise sign-in/);
  expect(screen.getByLabelText("Invite code (if required)")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  expect(calls).toEqual(["info"]);
  expect(api.inspectProfile).not.toHaveBeenCalled();
  expect(api.publishProfile).not.toHaveBeenCalled();
});

it("offers a connection-check retry instead of browser login after discovery failure", async () => {
  const community = "https://enterprise.example";
  api.communityRequest.mockResolvedValue({ name: "Enterprise", policy: null });
  api.inspectProfile.mockRejectedValue(
    new EnterpriseDiscoveryError("advertisement unavailable"),
  );
  const connect = vi.fn(async () => {
    throw new EnterpriseDiscoveryError("advertisement unavailable");
  });
  const retry = vi.fn();
  const snapshot = {
    status: "ready",
    relayAvailable: true,
    selected: null,
    memberships: [],
    profile: { name: "Local", picture: "" },
    enterprise: {
      communityId: community,
      status: "error" as const,
      errorKind: "discovery" as const,
      error: "advertisement unavailable",
    },
  } as const;
  const communities = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    connect,
    retryEnterpriseGate: retry,
    dismissEnterpriseLogin: vi.fn(),
  } as unknown as Communities;
  const user = userEvent.setup();
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(screen.getByLabelText("Relay URL"), community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await within(screen.getByRole("status")).findByText(
    "advertisement unavailable",
    {
      selector: 'p[role="alert"]',
    },
  );
  await user.click(
    screen.getByRole("button", { name: "Retry connection check" }),
  );
  expect(retry).toHaveBeenCalledWith(community);
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Invite code (if required)"),
  ).not.toBeInTheDocument();
});

it("does not inspect or admit after destination info resolves after unmount", async () => {
  const community = "https://enterprise.example";
  const info = deferred<{ name: string; policy: null }>();
  api.communityRequest.mockReturnValue(info.promise);
  const snapshot = {
    status: "ready",
    relayAvailable: true,
    selected: null,
    memberships: [],
    profile: { name: "Local", picture: "" },
  } as const;
  const communities = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    connect: vi.fn(),
    dismissEnterpriseLogin: vi.fn(),
  } as unknown as Communities;
  const user = userEvent.setup();
  const view = render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );

  await user.type(screen.getByLabelText("Relay URL"), community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(api.communityRequest).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => {
    info.resolve({ name: "Enterprise", policy: null });
    await info.promise;
  });

  expect(api.inspectProfile).not.toHaveBeenCalled();
  expect(communities.connect).not.toHaveBeenCalled();
});

it("does not begin admission when an unmounted access gate resolves", async () => {
  const community = "https://enterprise.example";
  const gate = deferred<unknown>();
  const calls: string[] = [];
  api.communityRequest.mockImplementation(
    async (_id: string, route: string) => {
      calls.push(route);
      if (route === "info")
        return {
          name: "Enterprise",
          policy: {
            version: "v1",
            terms_markdown: "Terms",
            age_attestation_required: true,
          },
        };
      throw new Error(`unexpected admission route: ${route}`);
    },
  );
  const connect = vi
    .fn()
    .mockRejectedValueOnce(new EnterpriseLoginRequired(community))
    .mockReturnValueOnce(gate.promise);
  const snapshot = {
    status: "ready",
    relayAvailable: true,
    selected: null,
    memberships: [],
    profile: { name: "Local", picture: "" },
    enterprise: { communityId: community, status: "required" as const },
  } as const;
  const communities = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    connect,
    dismissEnterpriseLogin: vi.fn(),
    joined: vi.fn(),
  } as unknown as Communities;
  const user = userEvent.setup();
  const view = render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(screen.getByLabelText("Relay URL"), community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Invite code (if required)");
  await user.type(
    screen.getByLabelText("Invite code (if required)"),
    "invite-123",
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: "I agree to this community’s Terms of Service and Privacy Notice.",
    }),
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: "I confirm that I am at least 18 years old.",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));

  view.unmount();
  await act(async () => {
    gate.resolve({});
    await gate.promise;
  });

  expect(api.inspectProfile).not.toHaveBeenCalled();
  expect(api.publishProfile).not.toHaveBeenCalled();
  expect(communities.joined).not.toHaveBeenCalled();
  expect(calls).toEqual(["info"]);
});

it("keeps invite admission behind the gate after Not now, then admits after recovery", async () => {
  const community = "https://enterprise.example";
  const calls: string[] = [];
  api.communityRequest.mockImplementation(
    async (_id: string, route: string, _body?: unknown) => {
      calls.push(route);
      if (route === "info")
        return {
          name: "Enterprise",
          policy: {
            version: "v1",
            terms_markdown: "Terms",
            age_attestation_required: false,
          },
        };
      if (route === "accept-policy") return { receipt: "receipt-1" };
      if (route === "claim") return { status: "joined" };
      throw new Error(`unexpected admission route: ${route}`);
    },
  );
  api.inspectProfile.mockResolvedValue({
    exists: false,
    existing: {},
    profile: { name: "", picture: "", about: "" },
  });
  let authenticated = false;
  const connect = vi.fn(async () => {
    if (!authenticated) throw new EnterpriseLoginRequired(community);
    return {};
  });
  let state: Record<string, unknown> = {
    status: "ready",
    relayAvailable: true,
    viewer: "a".repeat(64),
    selected: null,
    memberships: [],
    profile: { name: "Local", picture: "" },
    enterprise: { communityId: community, status: "required" },
  };
  const listeners = new Set<() => void>();
  const communities = {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect,
    dismissEnterpriseLogin: vi.fn(() => {
      state = { ...state, enterprise: undefined };
      for (const listener of listeners) listener();
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  const user = userEvent.setup();
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );

  await user.type(screen.getByLabelText("Relay URL"), community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText(/requires enterprise sign-in/);
  await user.type(
    screen.getByLabelText("Invite code (if required)"),
    "invite-123",
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: "I agree to this community’s Terms of Service and Privacy Notice.",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(calls).toEqual(["info"]);
  expect(api.inspectProfile).not.toHaveBeenCalled();
  expect(api.publishProfile).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
  expect(calls).toEqual(["info"]);
  expect(api.inspectProfile).not.toHaveBeenCalled();
  expect(api.publishProfile).not.toHaveBeenCalled();

  authenticated = true;
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(api.inspectProfile).toHaveBeenCalledOnce());
  expect(calls).toEqual(["info", "accept-policy", "claim"]);
  expect(api.communityRequest).toHaveBeenNthCalledWith(
    2,
    community,
    "accept-policy",
    { code: "invite-123", policy_version: "v1", age_confirmed: false },
  );
  expect(api.communityRequest).toHaveBeenNthCalledWith(3, community, "claim", {
    code: "invite-123",
    policy_receipt: "receipt-1",
  });
  expect(api.publishProfile).not.toHaveBeenCalled();
});
