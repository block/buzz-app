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
import type { HostRequest, HostResponse } from "../../../features/host/service";
import { deferred, createTestSession } from "../test-helpers";
import { createAgentClient } from "./client";
import { RemoteAgents } from "./RemoteAgents";
import { ToastProvider } from "../../../shared/design-system/ui/Toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reports an empty signed-out overview without starting a list request", async () => {
  const h = await fixture();
  h.session.signOut();
  const held = deferred<HostResponse>();
  h.request.mockReturnValue(held.promise);
  const overview = vi.fn();
  render(<RemoteAgents {...h} active={() => true} onOverview={overview} />);
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  expect(h.request).not.toHaveBeenCalled();
  await act(async () => held.resolve(response([], 401)));
  expect(overview).toHaveBeenCalledTimes(1);
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
const row = {
  agent_id: "one",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: 2,
  model_selection_status: 1,
};
const response = (agents: unknown[], status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify({ status: 1, agents }),
});
async function fixture(canUseRemoteAgents = true) {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const session = createTestSession(
    async () => ({
      revision: "secret",
      account: {
        subject: "user",
        email: "a@example.com",
        canUseRemoteAgents,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: (input) => request(input) },
  );
  await session.signIn();
  const request = vi.fn(async (_input: HostRequest) => response([row]));
  const client = createAgentClient(session);
  return { session, client, request };
}
it("omits the agent summary when remote agents are unavailable", async () => {
  const h = await fixture(false);
  const overview = vi.fn();
  render(<RemoteAgents {...h} active={() => true} onOverview={overview} />);
  expect(screen.getByText("Unavailable for this account")).toBeVisible();
  expect(
    screen.queryByText("Agents", { selector: "dt" }),
  ).not.toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({ kind: "unavailable" });
  expect(h.request).not.toHaveBeenCalled();
});
it("loads automatically, refreshes and hides account data on sign-out", async () => {
  const h = await fixture();
  const overview = vi.fn();
  const openAgents = vi.fn();
  render(
    <RemoteAgents
      {...h}
      active={() => true}
      onOverview={overview}
      openAgents={openAgents}
    />,
  );
  expect(overview).toHaveBeenLastCalledWith({ kind: "pending" });
  expect(await screen.findByText("Helper")).toBeInTheDocument();
  expect(
    screen.queryByText("Agents", { selector: "dt" }),
  ).not.toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({
    kind: "filled",
    items: [{ key: "one", label: "Helper" }],
  });
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Configured$/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "More actions for Helper" }),
  ).toBeEnabled();
  expect(document.body).not.toHaveTextContent("secret");
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  const copy = screen.getByRole("button", { name: "More actions for Helper" });
  copy.focus();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(copy).toHaveFocus();
  expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({
    kind: "filled",
    items: [{ key: "one", label: "Helper" }],
  });
  await act(async () => held.resolve(response([row])));
  expect(copy).toHaveFocus();
  h.request.mockResolvedValueOnce(response([]));
  act(() => window.dispatchEvent(new Event("focus")));
  expect(await screen.findByText("No agents yet")).toBeInTheDocument();
  expect(overview).toHaveBeenLastCalledWith({ kind: "empty" });
  await userEvent.click(screen.getByRole("button", { name: "Open Agents" }));
  expect(openAgents).toHaveBeenCalledTimes(1);
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
  expect(screen.getByRole("status")).toHaveTextContent("Loading agents");
  expect(
    screen.queryByRole("button", { name: "Refresh agents" }),
  ).not.toBeInTheDocument();
  await act(async () => held.resolve(response([], 400)));
  expect(
    screen.getByRole("heading", { name: "Couldn’t load agents" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
  const automatic = deferred<HostResponse>();
  h.request.mockReturnValueOnce(automatic.promise);
  try {
    act(() => window.dispatchEvent(new Event("focus")));
    expect(screen.queryByText("Loading agents…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Helper")).toBeInTheDocument();
  } finally {
    await act(async () => automatic.resolve(response([], 400)));
  }
  expect(screen.getByText("Helper")).toBeVisible();
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
    expect(screen.queryByText("Helper")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

it("copies the agent key and exposes a recoverable clipboard failure", async () => {
  const h = await fixture();
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(
    <ToastProvider>
      <RemoteAgents {...h} active={() => true} />
    </ToastProvider>,
  );
  const copy = await screen.findByRole("button", {
    name: "More actions for Helper",
  });
  const copyKey = async () => {
    await userEvent.click(copy);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Copy key" }),
    );
  };
  await copyKey();
  expect(
    await screen.findByRole("dialog", { name: "Couldn’t copy the key" }),
  ).toHaveTextContent("Couldn’t copy the key");
  expect(screen.queryByText(row.agent_pubkey)).not.toBeInTheDocument();
  await copyKey();
  expect(screen.getByRole("dialog", { name: "Key copied" })).toHaveTextContent(
    "Key copied",
  );
  expect(writeText).toHaveBeenLastCalledWith(row.agent_pubkey);
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  copy.focus();
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => held.resolve(response([], 400)));
  await waitFor(() => expect(copy).toHaveFocus());
  expect(screen.getByRole("dialog", { name: "Key copied" })).toHaveTextContent(
    "Key copied",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each([
  [2, 1, "Configured"],
  [2, 2, "Needs setup"],
  [2, undefined, "Needs setup"],
  [1, 1, "Needs setup"],
  [3, 1, "Revoked"],
  [0, 1, "Unknown"],
])(
  "shows readiness for agent %s and model %s",
  async (status, model, label) => {
    const h = await fixture();
    h.request.mockResolvedValue(
      response([
        {
          ...row,
          status,
          model_selection_status: model,
          created_at: "2026-07-15T12:00:00Z",
        },
      ]),
    );
    render(<RemoteAgents {...h} active={() => true} />);
    expect(await screen.findByText(new RegExp(`${label}$`))).toBeVisible();
  },
);

it("uses saved avatars and opens saved rows independently of their action menus", async () => {
  const h = await fixture();
  const openAgent = vi.fn();
  const picture = "https://example.com/helper.png";
  let active = true;
  const props = { ...h, active: () => active, openAgent };
  const view = render(
    <RemoteAgents
      {...props}
      savedAgents={[{ pubkey: row.agent_pubkey, picture }]}
    />,
  );
  const open = await screen.findByRole("button", {
    name: "View Helper",
  });
  const image = screen.getByText("Helper").closest("li")?.querySelector("img");
  expect(open).toHaveAccessibleDescription(/Configured/);
  expect(screen.getByText("In Agents")).toBeVisible();
  expect(image).toHaveAttribute("src", picture);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "More actions for Helper" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "View Agent" }),
  ).toBeVisible();
  await user.click(screen.getByRole("menuitem", { name: "Copy key" }));
  expect(openAgent).not.toHaveBeenCalled();
  await user.click(open);
  open.focus();
  await user.keyboard("{Enter}");
  expect(openAgent.mock.calls).toEqual([
    [row.agent_pubkey],
    [row.agent_pubkey],
  ]);
  active = false;
  await user.click(open);
  expect(openAgent).toHaveBeenCalledTimes(2);
  view.rerender(<RemoteAgents {...props} savedAgents={[]} />);
  expect(screen.queryByRole("button", { name: "View Helper" })).toBeNull();
  expect(screen.queryByText("In Agents")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "More actions for Helper" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Copy key" }),
  ).toBeVisible();
  expect(screen.queryByRole("menuitem", { name: "View Agent" })).toBeNull();
  expect(
    view.container.querySelector("img[src='https://example.com/helper.png']"),
  ).toBeNull();
});

const requester = { ...row, agent_id: "boss", agent_name: "Boss" };
const requested = {
  agent_id: "two",
  agent_name: "Scout",
  agent_pubkey: "cd".repeat(32),
  status: 1,
  requested_by_agent_pubkey: row.agent_pubkey,
  agent_instructions: "Watch the build.",
};
async function requestedFixture() {
  const h = await fixture();
  h.request.mockResolvedValue(response([requester, requested]));
  const review = {
    approve: vi.fn(async (..._: unknown[]) => {}),
    reject: vi.fn(async (..._: unknown[]) => {}),
  };
  render(
    <ToastProvider>
      <RemoteAgents {...h} active={() => true} review={review} />
    </ToastProvider>,
  );
  await screen.findByText("Scout");
  return { ...h, review };
}

async function reject(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "More actions for Scout" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Reject" }));
}

it("offers approval only for a listed unattested agent another agent requested", async () => {
  await requestedFixture();
  const scout = screen.getByText("Scout").closest("li");
  expect(scout).toHaveTextContent("Requested by Boss");
  expect(
    within(scout as HTMLElement).getByRole("button", { name: "Approve" }),
  ).toBeVisible();
  const boss = screen.getByText("Boss").closest("li");
  expect(
    within(boss as HTMLElement).queryByRole("button", { name: "Approve" }),
  ).toBeNull();
  cleanup();
  const plain = await fixture();
  plain.request.mockResolvedValue(
    response([{ ...requested, requested_by_agent_pubkey: undefined }]),
  );
  render(
    <RemoteAgents
      {...plain}
      active={() => true}
      review={{ approve: vi.fn(), reject: vi.fn() }}
    />,
  );
  await screen.findByText("Scout");
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.getByText(/Needs setup$/)).toBeVisible();
});

it("approves with the instructions the owner reviewed, then reloads the list", async () => {
  const h = await requestedFixture();
  const user = userEvent.setup();
  const held = deferred<void>();
  h.review.approve.mockReturnValueOnce(held.promise);
  await user.click(screen.getByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Approve Scout?",
  });
  expect(dialog).toHaveTextContent("Requested by Boss");
  const box = within(dialog).getByRole("textbox", { name: /Instructions/ });
  expect(box).toHaveValue("Watch the build.");
  await user.type(box, " Nightly.");
  h.request.mockResolvedValue(response([requester]));
  await user.click(within(dialog).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(h.review.approve).toHaveBeenCalledTimes(1));
  expect(h.review.approve).toHaveBeenCalledWith(
    expect.objectContaining({ name: "Scout", pubkey: requested.agent_pubkey }),
    "Watch the build. Nightly.",
    expect.any(AbortSignal),
  );
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(box).toBeDisabled();
  await act(async () => held.resolve());
  await waitFor(() => expect(screen.queryByText("Scout")).toBeNull());
  expect(h.request).toHaveBeenCalledTimes(2);
});

it("keeps the approval open with its error until it succeeds", async () => {
  const h = await requestedFixture();
  const user = userEvent.setup();
  h.review.approve.mockRejectedValueOnce(new Error("Provider down."));
  await user.click(screen.getByRole("button", { name: "Approve" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve Scout?" });
  await user.click(within(dialog).getByRole("button", { name: "Approve" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Provider down.",
  );
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(h.request).toHaveBeenCalledTimes(1);
  await user.click(within(dialog).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(h.review.approve).toHaveBeenCalledTimes(2));
});

it("rejects only after confirmation, then reloads the list", async () => {
  const h = await requestedFixture();
  const user = userEvent.setup();
  const held = deferred<void>();
  h.review.reject.mockReturnValueOnce(held.promise);
  await reject(user);
  const dialog = await screen.findByRole("alertdialog", {
    name: "Reject Scout?",
  });
  expect(h.review.reject).not.toHaveBeenCalled();
  h.request.mockResolvedValue(response([requester]));
  await user.click(within(dialog).getByRole("button", { name: "Reject" }));
  await waitFor(() => expect(h.review.reject).toHaveBeenCalledTimes(1));
  expect(h.review.reject).toHaveBeenCalledWith(
    expect.objectContaining({ id: "two" }),
    expect.any(AbortSignal),
  );
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  await act(async () => held.resolve());
  await waitFor(() => expect(screen.queryByText("Scout")).toBeNull());
});

it("shows a failed rejection and leaves the request listed", async () => {
  const h = await requestedFixture();
  const user = userEvent.setup();
  h.review.reject.mockRejectedValueOnce(
    new Error("Deletion was not confirmed."),
  );
  await reject(user);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Reject" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Deletion was not confirmed.",
  );
  expect(screen.getByText("Scout")).toBeInTheDocument();
});
