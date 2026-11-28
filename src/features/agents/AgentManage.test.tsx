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
import { AgentArchiveRetry, AgentDelete, AgentRemoveHere } from "./AgentManage";
import type { Agent, Agents } from "./service";

afterEach(cleanup);

const agent = {
  key: "1".repeat(64),
  pubkey: "1".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
} satisfies Agent;

it("closes the dialog immediately on confirm, shows deleting progress, surfaces errors inline, and lets retry finish", async () => {
  const user = userEvent.setup();
  let failFirst!: (error: Error) => void;
  const remove = vi
    .fn<Agents["remove"]>()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failFirst = reject;
        }),
    )
    .mockResolvedValueOnce(undefined);
  const onRemoved = vi.fn();
  render(
    <AgentDelete
      agents={{ remove, memberships: () => [] } as unknown as Agents}
      agent={agent}
      onRemoved={onRemoved}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Delete agent" }));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  // Dialog closes right away instead of blocking the UI while delete runs.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  failFirst(new Error("Credential store refused"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Credential store refused",
  );
  expect(onRemoved).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete agent" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Ada?" });
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Credential store refused",
  );
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  await vi.waitFor(() => expect(onRemoved).toHaveBeenCalledOnce());
  expect(remove).toHaveBeenCalledWith(agent.key);
});

it("retries an unchecked archive state and shows what is left", async () => {
  const user = userEvent.setup();
  const unarchive = vi
    .fn<Agents["unarchive"]>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce("Ada is still archived.");
  const { rerender } = render(
    <AgentArchiveRetry agents={{ unarchive }} agent={agent} />,
  );
  expect(screen.queryByText("Archive state")).toBeNull();
  rerender(
    <AgentArchiveRetry
      agents={{ unarchive }}
      agent={{ ...agent, archiveUnchecked: true }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("Couldn't check whether it's archived: offline"),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Ada is still archived.")).toBeVisible();
  expect(unarchive).toHaveBeenCalledWith(agent.key);
});

it.each(["delete", "remove"] as const)(
  "%s starts on Cancel and Enter leaves the agent unchanged",
  async (action) => {
    const user = userEvent.setup();
    const remove = vi.fn();
    const leave = vi.fn();
    const onRemoved = vi.fn();
    const agents = {
      remove,
      leave,
      memberships: () => [],
    } as unknown as Agents;
    const props = { agents, agent, onRemoved };
    render(
      action === "delete" ? (
        <AgentDelete {...props} />
      ) : (
        <AgentRemoveHere
          {...props}
          trigger={(open) => (
            <button type="button" onClick={open}>
              Remove agent
            </button>
          )}
        />
      ),
    );
    const trigger = screen.getByRole("button", {
      name: action === "delete" ? "Delete agent" : "Remove agent",
    });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toHaveFocus(),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
  },
);
