// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createAgentClient } from "./client";
import { RemoteAgents } from "./RemoteAgents";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const row = {
  agent_id: "one",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: 2,
};
const response = (agents: unknown[], status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify({ status: 1, agents }),
});
async function fixture() {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: { subject: "user", email: "a@example.com" },
  }));
  await session.signIn();
  const request = vi.fn(async (_input: HostRequest) => response([row]));
  const authorize = vi.fn(
    async () => ["auth", "cd".repeat(32), "", "ef".repeat(64)] as const,
  );
  const client = createAgentClient(
    {
      request,
      runCommand: vi.fn(),
      prepareRemoteAgentAuthorization: authorize,
    },
    session,
  );
  return { session, client, request, authorize };
}
afterEach(() => vi.unstubAllEnvs());
it("loads automatically, refreshes and hides account data on sign-out", async () => {
  const h = await fixture();
  render(<RemoteAgents {...h} active={() => true} />);
  expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
  expect(screen.getByText(row.agent_pubkey)).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("secret");
  h.request.mockResolvedValue(response([]));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Refresh agents" }));
  expect(await screen.findByText("No remote agents yet.")).toBeInTheDocument();
  act(() => h.session.signOut());
  expect(
    screen.queryByRole("region", { name: "Remote agents" }),
  ).not.toBeInTheDocument();
});
it("shows a held loading state and retries a failed read", async () => {
  const h = await fixture();
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  render(<RemoteAgents {...h} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading remote agents");
  expect(
    screen.getByRole("button", { name: "Refresh agents" }),
  ).toHaveAttribute("aria-disabled", "true");
  await act(async () => held.resolve(response([], 503)));
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503");
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each(["sign-out", "unmount"])(
  "ignores held reads after %s",
  async (action) => {
    const h = await fixture();
    const held = deferred<HostResponse>();
    h.request.mockReturnValue(held.promise);
    const mounted = render(<RemoteAgents {...h} active={() => true} />);
    if (action === "sign-out") act(() => h.session.signOut());
    else mounted.unmount();
    await act(async () => held.resolve(response([row])));
    expect(screen.queryByText("Helper · Active")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

it("keeps creation controls locked through registration and attestation, then clears the submitted name", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(response([]));
  render(<RemoteAgents {...h} active={() => true} />);
  await screen.findByText("No remote agents yet.");
  const held = deferred<HostResponse>();
  const attestation = deferred<HostResponse>();
  h.request
    .mockReturnValueOnce(held.promise)
    .mockReturnValueOnce(attestation.promise);
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "Agent name" }),
    "Helper",
  );
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(screen.getByRole("textbox", { name: "Agent name" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh agents" })).toBeDisabled();
  await act(async () =>
    held.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    }),
  );
  expect(h.request).toHaveBeenCalledTimes(3);
  expect(screen.getByText("Helper · Unattested")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Agent name" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Finish setup" })).toBeDisabled();
  await act(async () =>
    attestation.resolve({ status: 200, headers: {}, body: '{"status":1}' }),
  );
  expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Agent name" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Refresh agents" })).toBeEnabled();
});
it("keeps the registered identity visible after failed attestation and finishes without registering again", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce(response([]));
  render(<RemoteAgents {...h} active={() => true} />);
  await screen.findByText("No remote agents yet.");
  h.request
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    })
    .mockResolvedValueOnce(response([], 503));
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "Agent name" }),
    "Helper",
  );
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");
  expect(screen.getByText("Helper · Unattested")).toBeInTheDocument();
  h.request.mockResolvedValueOnce({
    status: 200,
    headers: {},
    body: '{"status":1}',
  });
  await user.click(screen.getByRole("button", { name: "Finish setup" }));
  expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
  expect(
    h.request.mock.calls.filter(([input]) =>
      input.url.endsWith("/register-agent"),
    ),
  ).toHaveLength(1);
});
it("does not attest or show a held registration after sign-out", async () => {
  const h = await fixture();
  render(<RemoteAgents {...h} active={() => true} />);
  await screen.findByText("Helper · Active");
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "Agent name" }),
    "Another",
  );
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  act(() => h.session.signOut());
  await act(async () =>
    held.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agent_id: "two",
        agent_pubkey: row.agent_pubkey,
      }),
    }),
  );
  expect(h.authorize).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: "Remote agents" }),
  ).not.toBeInTheDocument();
});

it.each(["registration", "signing"])(
  "does not continue creation when card ownership is lost during %s before effect cleanup",
  async (stage) => {
    const h = await fixture();
    let active = true;
    render(<RemoteAgents {...h} active={() => active} />);
    await screen.findByText("Helper · Active");
    const registered = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agent_id: "two",
        agent_pubkey: row.agent_pubkey,
      }),
    };
    const registration = deferred<HostResponse>();
    const signing = deferred<Awaited<ReturnType<typeof h.authorize>>>();
    const proof = ["auth", "cd".repeat(32), "", "ef".repeat(64)] as const;
    if (stage === "registration")
      h.request.mockReturnValueOnce(registration.promise);
    else {
      h.request.mockResolvedValueOnce(registered);
      h.authorize.mockReturnValueOnce(signing.promise);
    }
    try {
      const user = userEvent.setup();
      await user.type(
        screen.getByRole("textbox", { name: "Agent name" }),
        "Another",
      );
      await user.click(screen.getByRole("button", { name: "Create agent" }));
      await waitFor(() => {
        expect(h.request).toHaveBeenCalledTimes(2);
        expect(h.authorize).toHaveBeenCalledTimes(stage === "signing" ? 1 : 0);
      });
      // Revoke ownership without unmounting or signing out: the signal is still live.
      active = false;
      await act(async () => {
        registration.resolve(registered);
        signing.resolve(proof);
      });
      expect(h.request).toHaveBeenCalledTimes(2);
      expect(h.authorize).toHaveBeenCalledTimes(stage === "signing" ? 1 : 0);
      expect(screen.queryAllByText("Another · Unattested")).toHaveLength(
        stage === "signing" ? 1 : 0,
      );
      expect(screen.queryByText("Another · Active")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      registration.resolve(registered);
      signing.resolve(proof);
    }
  },
);
