// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Communities } from "../features/communities/service";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { stubAvatarBrowserApis } from "../features/agents/avatar-testing";
import { ProfileSettings } from "./ProfileSettings";

vi.mock("../features/identity/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../features/identity/service")>()),
  nativeIdentityEnabled: () => true,
}));

stubAvatarBrowserApis();

const viewer = "ab".repeat(32);

function fixture(clearEnterpriseAuth: Communities["clearEnterpriseAuth"]) {
  const state = {
    status: "ready" as const,
    relayAvailable: true,
    viewer,
    profile: { name: "Local", picture: "" },
    memberships: [{ id: "https://community.example", name: "Community" }],
    selected: "https://community.example",
  };
  return {
    state,
    service: {
      snapshot: () => state,
      subscribe: () => () => {},
      clearEnterpriseAuth,
      relay: { snapshot: () => ({ status: "unavailable" }) },
    } as unknown as Communities,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("clears the shared BuilderLab session without changing identity or memberships", async () => {
  const clearEnterpriseAuth = vi.fn(async () => {});
  const { service, state } = fixture(clearEnterpriseAuth);
  const before = structuredClone(state);
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, {
    wrapper: ToastProvider,
  });

  const clearCopy = screen.getByText(/shared BuilderLab session/);
  expect(clearCopy).toHaveTextContent("configured profile and service");
  expect(clearCopy).toHaveTextContent(
    "CLI or other clients using that same profile and service to sign in again.",
  );
  await user.click(
    screen.getByRole("button", { name: "Clear enterprise sign-in" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Enterprise sign-in was cleared on this device.",
    ),
  );
  expect(clearEnterpriseAuth).toHaveBeenCalledOnce();
  expect(state).toEqual(before);
  expect(screen.getByText("Nostr address (npub)")).toBeVisible();
});

it("reports a local enterprise-session clear failure and remains retryable", async () => {
  const clearEnterpriseAuth = vi.fn(async () => {
    throw new Error("Secure storage unavailable");
  });
  const { service } = fixture(clearEnterpriseAuth);
  const user = userEvent.setup();
  render(<ProfileSettings communities={service} />, {
    wrapper: ToastProvider,
  });

  await user.click(
    screen.getByRole("button", { name: "Clear enterprise sign-in" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Secure storage unavailable",
  );
  expect(
    screen.getByRole("button", { name: "Clear enterprise sign-in" }),
  ).toBeEnabled();
});

it("keeps local enterprise reset available when a community profile cannot load", async () => {
  const clearEnterpriseAuth = vi.fn(async () => {});
  const { service, state } = fixture(clearEnterpriseAuth);
  service.connect = vi.fn(async () => {
    throw new Error("Saved enterprise session unavailable");
  });
  const user = userEvent.setup();
  render(
    <ProfileSettings communities={service} community={state.memberships[0]} />,
    { wrapper: ToastProvider },
  );

  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Saved enterprise session unavailable",
    ),
  );
  await user.click(
    screen.getByRole("button", { name: "Clear enterprise sign-in" }),
  );
  await waitFor(() => expect(clearEnterpriseAuth).toHaveBeenCalledOnce());
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your profile in Community couldn’t be loaded",
  );
});
