// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
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
});

it("keeps admission side effects behind the gate after Not now", async () => {
  const community = "https://enterprise.example";
  const calls: string[] = [];
  api.communityRequest.mockImplementation(
    async (_id: string, route: string) => {
      calls.push(route);
      if (route === "info") return { name: "Enterprise", policy: null };
      throw new Error(`unexpected admission route: ${route}`);
    },
  );
  api.inspectProfile.mockResolvedValue({
    exists: false,
    existing: {},
    profile: { name: "", picture: "", about: "" },
  });
  let attempts = 0;
  const connect = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) throw new EnterpriseLoginRequired(community);
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
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(calls).toEqual(["info"]);
  expect(api.inspectProfile).not.toHaveBeenCalled();
  expect(api.publishProfile).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
  expect(calls).toEqual(["info"]);
  expect(api.inspectProfile).toHaveBeenCalledOnce();
  expect(api.publishProfile).not.toHaveBeenCalled();
});
