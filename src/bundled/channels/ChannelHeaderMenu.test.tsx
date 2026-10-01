// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRef, useLayoutEffect } from "react";
import { ChannelHeaderMenu } from "./ChannelHeaderMenu";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  ChannelNavigationProvider,
  useChannelNavigation,
  type ChannelMenuSurface,
} from "../../features/channel-navigation/ChannelNavigationState";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import type { RelayData } from "../../features/relay/service";

const channel: ChannelSummary = {
  id: "alpha",
  name: "Alpha",
  channelType: "stream",
};
afterEach(cleanup);
function harness(value: ChannelSummary | undefined = channel) {
  const details = {
    channelId: "alpha",
    version: "v1",
    name: "Alpha",
    description: "Description",
    visibility: "public" as const,
    canEdit: true,
  };
  const load = vi.fn(async () => details);
  const save = vi.fn(async () => {});
  const lifecycleLoad = vi.fn(async () => ({
    channelId: "alpha",
    channelType: "stream",
    canArchive: true,
    canDelete: true,
    canLeave: false,
    canHide: false,
  }));
  const run = vi.fn();
  const session = {
    channelDetails: {
      available: true,
      load,
      save,
      snapshot: () => undefined,
      subscribe: () => () => {},
    },
    channelLifecycle: { available: true, load: lifecycleLoad, run },
  } as unknown as RelaySession;
  const snapshot = { session, status: "ready", scope: "menu-test" };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const props = {
    channel: value,
    session,
    providers: {
      snapshot: () => [],
      subscribe: () => () => {},
      register: () => {},
    },
    templateProvider: undefined,
    trigger: createRef<HTMLButtonElement>(),
    openDetails: vi.fn(),
    openCanvas: vi.fn(),
  };
  const mount = (
    publish?: (surface: ChannelMenuSurface) => React.ReactNode[],
  ) =>
    render(
      <ChannelNavigationProvider relay={relay}>
        {publish && <PublishActions actions={publish} />}
        <ChannelHeaderMenu {...props} />
      </ChannelNavigationProvider>,
    );
  return { props, mount, load, save, run, lifecycleLoad, details };
}
it("loads only on demand, uses the non-compact shared menu, and opens details without mutation", async () => {
  const h = harness();
  h.mount();
  const user = userEvent.setup();
  expect(h.load).not.toHaveBeenCalled();
  expect(h.lifecycleLoad).not.toHaveBeenCalled();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  await user.click(trigger);
  expect(await screen.findByRole("menu")).toHaveAttribute(
    "data-size",
    "default",
  );
  await screen.findByRole("menuitem", { name: "Delete channel" });
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual([
    "View channel details",
    "View canvas",
    "Edit details",
    "Archive channel",
    "Delete channel",
  ]);
  expect(
    screen
      .getByRole("menuitem", { name: "Edit details" })
      .querySelector(".buzz-menu-icon svg"),
  ).toHaveAttribute("aria-hidden", "true");
  expect(h.run).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("menuitem", { name: "View channel details" }),
  );
  expect(h.props.openDetails).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await user.click(
    await screen.findByRole("menuitem", { name: "View channel details" }),
  );
  expect(h.props.openDetails).toHaveBeenCalledTimes(2);
});
it("supports keyboard dismissal, outside clicks, and Canvas with the stable header focus target", async () => {
  const h = harness();
  h.mount();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "View channel details" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  await user.click(document.body);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await user.click(
    await screen.findByRole("menuitem", { name: "View canvas" }),
  );
  expect(h.props.openCanvas).toHaveBeenCalledWith(trigger);
});
it("keeps the real details dialog alive after menu dismissal and returns focus on Cancel", async () => {
  const h = harness();
  h.mount();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit details" }),
  );
  await screen.findByRole("dialog", { name: "Edit channel details" });
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), " draft");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(h.save).not.toHaveBeenCalled();
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit details" }),
  );
  expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue(
    "Alpha",
  );
});
it("rechecks permission on reopening and retries a failed details read", async () => {
  const h = harness();
  h.mount();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  await user.click(trigger);
  await screen.findByRole("menuitem", { name: "Edit details" });
  await user.keyboard("{Escape}");
  h.load.mockRejectedValueOnce(new Error("Unavailable"));
  await user.click(trigger);
  await screen.findByText("Channel details unavailable");
  expect(
    screen.queryByRole("menuitem", { name: "Edit details" }),
  ).not.toBeInTheDocument();
  h.load.mockResolvedValue({ ...h.details, canEdit: false });
  await user.click(screen.getByRole("menuitem", { name: "Reload details" }));
  await waitFor(() =>
    expect(
      screen.queryByText("Channel details unavailable"),
    ).not.toBeInTheDocument(),
  );
  expect(h.load).toHaveBeenCalledTimes(3);
  expect(
    screen.queryByRole("menuitem", { name: "Edit details" }),
  ).not.toBeInTheDocument();
});
it.each([
  { readOnly: true as const },
  { cached: true as const },
  { channelType: "session" as const },
])("preserves management eligibility for %j", async (flags) => {
  const h = harness({ ...channel, ...flags });
  h.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  await screen.findByRole("menuitem", { name: "View channel details" });
  expect(h.load).not.toHaveBeenCalled();
  expect(h.lifecycleLoad).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("menuitem", { name: "Edit details" }),
  ).not.toBeInTheDocument();
});
it("does not offer editing for archived channels", async () => {
  const h = harness({ ...channel, archived: true });
  h.lifecycleLoad.mockResolvedValue({
    channelId: "alpha",
    channelType: "stream",
    canArchive: false,
    canDelete: false,
    canLeave: false,
    canHide: false,
  });
  h.mount();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Channel actions" }));
  expect(h.lifecycleLoad).not.toHaveBeenCalled();
  expect(h.load).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("menuitem", { name: "Delete channel" }),
  ).not.toBeInTheDocument();
});

function PublishActions({
  actions,
}: {
  actions(surface: ChannelMenuSurface): React.ReactNode[];
}) {
  const owner = useChannelNavigation()?.menuActions;
  useLayoutEffect(() => {
    owner?.publish((_channel, surface) => actions(surface));
    return () => owner?.publish(undefined);
  }, [owner, actions]);
  return null;
}
it("keeps shared read pending/errors in the header and retires dismissed completions", async () => {
  const h = harness();
  let reject!: (error: Error) => void;
  const first = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  let resolve!: () => void;
  const second = new Promise<void>((done) => {
    resolve = done;
  });
  const write = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  h.mount((surface) => [
    <MenuItem
      key="read"
      closeOnClick={false}
      disabled={surface.pending}
      onClick={() => void surface.runRead(write)}
    >
      Mark as Read
    </MenuItem>,
  ]);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Mark as Read" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  expect(
    screen.getByRole("menuitem", { name: "Mark as Read" }),
  ).toHaveAttribute("aria-disabled", "true");
  await act(async () => reject(new Error("Read failed")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Read failed");
  await user.click(screen.getByRole("menuitem", { name: "Mark as Read" }));
  expect(write).toHaveBeenCalledTimes(2);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  await user.click(trigger);
  await screen.findByRole("menu");
  await act(async () => resolve());
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("offers DM Hide using the existing lifecycle permissions, not stream actions", async () => {
  const h = harness({ ...channel, channelType: "dm" });
  h.lifecycleLoad.mockResolvedValue({
    channelId: "alpha",
    channelType: "dm",
    canLeave: false,
    canArchive: false,
    canDelete: false,
    canHide: true,
  });
  h.mount();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Channel actions" }));
  await screen.findByRole("menuitem", { name: "Hide conversation" });
  expect(h.load).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("menuitem", { name: "Delete channel" }),
  ).not.toBeInTheDocument();
  expect(h.run).not.toHaveBeenCalled();
});
