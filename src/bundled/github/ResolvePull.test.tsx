// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { PullChecklist } from "./pull";
import { ResolvePull } from "./ResolvePull";

afterEach(cleanup);
const url = "https://github.com/example/project/pull/1";
const agent = "a".repeat(64);
function harness({
  state = "open",
  merge = "DIRTY",
  checks = "failure",
  action = "failures",
  members = [agent],
  complete = true,
  rootId,
  type = "solo",
}: {
  state?: string;
  merge?: string;
  checks?: string;
  action?: "failures" | "conflicts";
  members?: string[];
  complete?: boolean;
  rootId?: string;
  type?: string;
} = {}) {
  const channel = {
    id: "chat",
    name: "Work",
    channelType: type,
    creator: "viewer",
    members,
  };
  const channels = { status: "ready", channels: [channel] };
  const choices = {
    selectable: members.map((pubkey, i) => ({
      pubkey,
      name: `Agent ${i + 1}`,
    })),
    complete,
    pending: false,
    archives: { status: "ready" },
  };
  const send = vi.fn(() => "receipt");
  const reply = vi.fn(() => "receipt");
  const refreshMembership = vi.fn(async () => channel);
  const session = {
    viewer: "viewer",
    channels: {
      list: () => channels,
      subscribeList: () => () => {},
      ensureList: () => () => {},
    },
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: vi.fn(),
      refresh: vi.fn(async () => {}),
    },
    channelWrites: { refreshMembership },
    messages: { send, reply },
  };
  const snapshot = { status: "ready", generation: 1, scope: "scope", session };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const pull = {
    state,
    merge,
    base: "main",
    head: "abc",
    checks: {
      state: checks,
      checks: [
        {
          name: "Tests",
          category: checks === "failure" ? "failing" : "successful",
        },
      ],
    },
  } as unknown as PullChecklist;
  const view = render(
    <ResolvePull
      relay={relay}
      channelId="chat"
      rootId={rootId}
      url={url}
      pull={pull}
      action={action}
    />,
  );
  return { ...view, send, reply, refreshMembership, channel, choices };
}
it.each(["failures", "conflicts"] as const)(
  "sends a short linked %s request directly to the sole chat agent",
  async (action) => {
    const h = harness({ action });
    await userEvent.click(
      screen.getByRole("button", { name: `Resolve ${action}` }),
    );
    await waitFor(() =>
      expect(h.send).toHaveBeenCalledWith(
        "chat",
        `[Resolve ${action}](${url})`,
        [agent],
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Requested" })).toBeDisabled();
  },
);
it("preserves a Team thread destination", async () => {
  const rootId = "b".repeat(64);
  const h = harness({ rootId, type: "stream" });
  await userEvent.click(
    screen.getByRole("button", { name: "Resolve failures" }),
  );
  await waitFor(() =>
    expect(h.reply).toHaveBeenCalledWith(
      "chat",
      rootId,
      `[Resolve failures](${url})`,
      [agent],
    ),
  );
  expect(h.send).not.toHaveBeenCalled();
});
it("requires a choice when several chat agents are available", async () => {
  const h = harness({ members: [agent, "b".repeat(64)] });
  expect(
    screen.getByRole("button", { name: "Resolve failures" }),
  ).toBeDisabled();
  await userEvent.click(screen.getByRole("combobox", { name: "Agent" }));
  await userEvent.click(await screen.findByRole("option", { name: "Agent 2" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Resolve failures" }),
  );
  await waitFor(() =>
    expect(h.send).toHaveBeenCalledWith("chat", `[Resolve failures](${url})`, [
      "b".repeat(64),
    ]),
  );
});
it("does not infer a recipient from incomplete inventory", () => {
  harness({ complete: false });
  expect(
    screen.getByRole("button", { name: "Resolve failures" }),
  ).toBeDisabled();
});
it("does not send after membership changes during preparation", async () => {
  const h = harness();
  h.refreshMembership.mockResolvedValue({ ...h.channel, members: [] });
  await userEvent.click(
    screen.getByRole("button", { name: "Resolve failures" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Resolve failures" }),
    ).toBeEnabled(),
  );
  expect(h.refreshMembership).toHaveBeenCalledOnce();
  expect(h.send).not.toHaveBeenCalled();
});
it("drops an in-flight request when its panel unmounts", async () => {
  const h = harness();
  let finish!: (channel: typeof h.channel) => void;
  h.refreshMembership.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Resolve failures" }),
  );
  h.unmount();
  await act(async () => {
    finish(h.channel);
  });
  expect(h.send).not.toHaveBeenCalled();
});
it.each(["merged", "closed"])(
  "hides resolution actions for %s PRs",
  (state) => {
    harness({ state });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  },
);
it("hides actions when checks pass", () => {
  harness({ merge: "CLEAN", checks: "success" });
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("allows retry after a send fails", async () => {
  const h = harness();
  h.send.mockImplementationOnce(() => {
    throw new Error("Send unavailable");
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Resolve failures" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Resolve failures" }),
    ).toBeEnabled(),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Resolve failures" }),
  );
  await screen.findByRole("button", { name: "Requested" });
  expect(h.send).toHaveBeenCalledTimes(2);
});
it("ignores repeated clicks while membership refresh is pending", async () => {
  const h = harness();
  let finish!: (channel: typeof h.channel) => void;
  h.refreshMembership.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const button = screen.getByRole("button", { name: "Resolve failures" });
  await userEvent.dblClick(button);
  expect(h.refreshMembership).toHaveBeenCalledOnce();
  expect(button).toBeDisabled();
  await act(async () => {
    finish(h.channel);
  });
  expect(h.send).toHaveBeenCalledOnce();
});
