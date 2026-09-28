// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelDetailsEditor } from "./ChannelDetailsEditor";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";
import type {
  ChannelDetailsCapability,
  DetailsAttempt,
} from "../../features/relay/channel-details";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";

afterEach(cleanup);
const channel = {
  id: "alpha",
  name: "Alpha",
  description: "Existing description",
  visibility: "public" as const,
  channelType: "stream" as const,
};
const base: ChannelDetails = {
  channelId: channel.id,
  version: "v1",
  name: channel.name,
  description: channel.description,
  visibility: "public",
  canEdit: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const setAttempt = (next: DetailsAttempt | undefined) => {
    attempt = next;
    for (const listener of listeners) listener();
  };
  return { capability, load, save, check, setAttempt };
}
it("edits deliberately, cancels every field, and sends all fields only on Save", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Renamed");
  await user.clear(screen.getByRole("textbox", { name: "Description" }));
  await user.click(screen.getByRole("combobox", { name: "Visibility" }));
  await user.click(screen.getByRole("option", { name: "Private" }));
  expect(
    screen.getByText(/Saving makes this channel invite-only/),
  ).toBeVisible();
  expect(h.save).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Edit details" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Alpha");
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    channel.description,
  );
  expect(
    screen.getByRole("combobox", { name: "Visibility" }),
  ).toHaveTextContent("Public");
  await user.clear(screen.getByRole("textbox", { name: "Description" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, description: "" },
    expect.any(AbortSignal),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Edit details" })).toHaveFocus(),
  );
});
it("retains rejected edits and preserves them through an explicit authority reload", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.save.mockRejectedValueOnce(new Error("Permission changed"));
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  await user.type(
    screen.getByRole("textbox", { name: "Description" }),
    " draft",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Permission changed",
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    `${channel.description} draft`,
  );
  h.load.mockResolvedValueOnce({ ...base, canEdit: false });
  await user.click(screen.getByRole("button", { name: "Reload details" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
  );
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue(
    `${channel.description} draft`,
  );
});
it("unknown outcomes survive remount and checking never invokes Save", async () => {
  const h = harness();
  const user = userEvent.setup();
  h.setAttempt({
    draft: { ...base, name: "Pending name" },
    status: "unconfirmed",
  });
  const first = render(
    <ChannelDetailsEditor capability={h.capability} channel={channel} />,
  );
  await screen.findByRole("button", { name: "Check save status" });
  expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  first.unmount();
  render(<ChannelDetailsEditor capability={h.capability} channel={channel} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Check save status" }),
    ).toBeEnabled(),
  );
  h.check.mockRejectedValueOnce(new Error("Not yet confirmed"));
  await user.click(screen.getByRole("button", { name: "Check save status" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Not yet confirmed",
  );
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Pending name",
  );
  expect(h.save).not.toHaveBeenCalled();
});
it.each(["channel", "session"])(
  "drops drafts and late reads when the %s changes",
  async (change) => {
    const h = harness(),
      next = harness();
    const user = userEvent.setup();
    const { rerender } = render(
      <ChannelDetailsEditor capability={h.capability} channel={channel} />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      " private draft",
    );
    const gate = deferred<ChannelDetails>();
    next.load.mockImplementationOnce(() => gate.promise);
    const changedChannel =
      change === "channel" ? { ...channel, id: "beta", name: "Beta" } : channel;
    rerender(
      <ChannelDetailsEditor
        capability={next.capability}
        channel={changedChannel}
      />,
    );
    expect(
      screen.queryByRole("textbox", { name: "Name" }),
    ).not.toBeInTheDocument();
    rerender(
      <ChannelDetailsEditor capability={h.capability} channel={channel} />,
    );
    await act(async () => {
      gate.resolve({ ...base, name: "Wrong late name" });
    });
    await user.click(
      await screen.findByRole("button", { name: "Edit details" }),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Alpha");
  },
);
it("keeps details readable without editing authority or host support", async () => {
  const h = harness();
  h.load.mockResolvedValueOnce({ ...base, canEdit: false });
  const { rerender } = render(
    <ChannelSettingsPanel
      channel={channel}
      details={h.capability}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(screen.getByText(channel.description)).toBeVisible();
  expect(screen.getByText("Public")).toBeVisible();
  await screen.findByText(/Only current channel owners/);
  expect(
    screen.queryByRole("button", { name: "Edit details" }),
  ).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel
      channel={{ ...channel, readOnly: true }}
      details={h.capability}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(screen.getByText(channel.description)).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Edit channel details" }),
  ).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel channel={channel} close={() => {}}>
      Diagnostics
    </ChannelSettingsPanel>,
  );
  expect(
    screen.getByText("Editing is unavailable on this connection."),
  ).toBeVisible();
});
