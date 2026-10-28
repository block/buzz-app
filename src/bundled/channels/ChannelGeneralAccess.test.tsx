// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelDetailsCapability,
  DetailsAttempt,
} from "../../features/relay/channel-details";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";
import { ChannelGeneralAccess } from "./ChannelGeneralAccess";

afterEach(cleanup);

it.each(["public", "private"] as const)(
  "shows verified %s access to readers without invoking the editing capability",
  (visibility) => {
    const h = harness();
    h.load.mockRejectedValue(
      new Error("Channel access changed. Reopen channel settings."),
    );
    render(
      <ChannelGeneralAccess
        capability={h.capability}
        channelId="alpha"
        channel={{
          id: "alpha",
          name: "Alpha",
          readOnly: true,
          visibility,
          joinRole: "guest",
        }}
      />,
    );
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).toHaveTextContent(
      visibility === "public"
        ? "Anyone in the community can read."
        : "Only invited people can read.",
    );
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).toHaveTextContent("Viewing only. Ask an owner or admin to participate.");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  },
);

const base: ChannelDetails = {
  channelId: "alpha",
  version: "v1",
  name: "Alpha",
  description: "Description",
  visibility: "private",
  joinRole: "guest",
  canEdit: true,
};
function harness() {
  let attempt: DetailsAttempt | undefined;
  const listeners = new Set<() => void>();
  const load = vi.fn(async () => base);
  const save = vi.fn(async () => {});
  const check = vi.fn(async () => {});
  const capability: ChannelDetailsCapability = {
    available: true,
    load,
    save,
    check,
    snapshot: () => attempt,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return {
    capability,
    load,
    save,
    check,
    setAttempt(next: DetailsAttempt | undefined) {
      attempt = next;
      for (const fn of listeners) fn();
    },
  };
}
async function select(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  option: string,
) {
  const control = screen.getByRole("combobox", { name: field });
  await waitFor(() => expect(control).toBeEnabled());
  await user.click(control);
  await user.click(await screen.findByRole("option", { name: option }));
  return control;
}
it.each(["public", "private"] as const)(
  "confirms %s reading access, cancels with focus return, and preserves individual/default roles",
  async (visibility) => {
    const h = harness();
    const current = { ...base, visibility };
    h.load.mockResolvedValue(current);
    const user = userEvent.setup();
    render(
      <ChannelGeneralAccess capability={h.capability} channelId="alpha" />,
    );
    const option =
      visibility === "public"
        ? "Invited people only"
        : "Anyone in the community";
    const control = await select(user, "Who can read", option);
    const confirm = screen.getByRole("alertdialog", {
      name: "Change general access?",
    });
    expect(confirm).toHaveAccessibleDescription(
      visibility === "public"
        ? "Only channel members will have access."
        : "Everyone in this community will be able to view this channel’s full history.",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    expect(h.save).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(control).toHaveFocus());
    expect(control).toHaveTextContent(
      visibility === "public"
        ? "Anyone in the community"
        : "Invited people only",
    );
    await select(user, "Who can read", option);
    const next = {
      ...current,
      visibility:
        visibility === "public" ? ("private" as const) : ("public" as const),
    };
    h.load.mockResolvedValue(next);
    await user.click(screen.getByRole("button", { name: "Change access" }));
    await waitFor(() => expect(control).toHaveTextContent(option));
    expect(h.save).toHaveBeenCalledExactlyOnceWith(
      current,
      next,
      expect.any(AbortSignal),
    );
  },
);
it("confirms new people's View only/Participate access independently of private reading access", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(<ChannelGeneralAccess capability={h.capability} channelId="alpha" />);
  await select(user, "New people can", "Participate");
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "People already in the channel keep their access.",
  );
  h.load.mockResolvedValue({ ...base, joinRole: "member" });
  await user.click(screen.getByRole("button", { name: "Change access" }));
  await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, joinRole: "member" },
    expect.any(AbortSignal),
  );
  expect(
    screen.getByRole("combobox", { name: "Who can read" }),
  ).toHaveTextContent("Invited people only");
});
it("shows the absent Member default without saving, and a declined save reloads current access", async () => {
  const h = harness();
  const current = { ...base, joinRole: undefined };
  h.load.mockResolvedValue(current);
  h.save.mockRejectedValueOnce(new Error("Channel details changed"));
  const user = userEvent.setup();
  render(<ChannelGeneralAccess capability={h.capability} channelId="alpha" />);
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "New people can" }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole("combobox", { name: "New people can" }),
  ).toHaveTextContent("Participate");
  expect(h.save).not.toHaveBeenCalled();
  await select(user, "New people can", "View only");
  await user.click(screen.getByRole("button", { name: "Change access" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Channel details changed",
  );
  h.load.mockResolvedValue({ ...base, canEdit: false });
  await user.click(screen.getByRole("button", { name: "Reload access" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "New people can" }),
    ).toHaveTextContent("View only"),
  );
  expect(
    screen.getByRole("combobox", { name: "New people can" }),
  ).toBeDisabled();
  expect(h.save).toHaveBeenCalledOnce();
});
it("locks both choices while saving and recovers an uncertain save after remount without resending", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.save.mockImplementationOnce(async () => {
    await gate;
    h.setAttempt({
      draft: { ...base, joinRole: "member" },
      status: "unconfirmed",
    });
    throw new Error("Readback unavailable");
  });
  const user = userEvent.setup();
  const view = render(
    <ChannelGeneralAccess capability={h.capability} channelId="alpha" />,
  );
  await select(user, "New people can", "Participate");
  try {
    await user.click(screen.getByRole("button", { name: "Change access" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    for (const control of screen.getAllByRole("combobox"))
      expect(control).toBeDisabled();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "General access" }),
      ).toHaveFocus(),
    );
  } finally {
    await act(async () => {
      release();
      await gate;
    });
  }
  await screen.findByRole("button", { name: "Check save status" });
  view.unmount();
  render(<ChannelGeneralAccess capability={h.capability} channelId="alpha" />);
  const check = await screen.findByRole("button", {
    name: "Check save status",
  });
  await waitFor(() => expect(check).toBeEnabled());
  h.check.mockImplementationOnce(async () => {
    h.setAttempt(undefined);
  });
  await user.click(check);
  await waitFor(() =>
    expect(h.check).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      expect.any(AbortSignal),
    ),
  );
  expect(h.save).toHaveBeenCalledOnce();
});
it("retires an open confirmation and late reads when the destination changes", async () => {
  const h = harness();
  const user = userEvent.setup();
  const view = render(
    <ChannelGeneralAccess capability={h.capability} channelId="alpha" />,
  );
  await select(user, "Who can read", "Anyone in the community");
  const pending = new Promise<ChannelDetails>(() => {});
  h.load.mockReturnValueOnce(pending);
  view.rerender(
    <ChannelGeneralAccess capability={h.capability} channelId="beta" />,
  );
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  for (const control of screen.getAllByRole("combobox"))
    expect(control).toBeDisabled();
  expect(h.save).not.toHaveBeenCalled();
});
