// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows known channel details with diagnostics collapsed until requested", async () => {
  const user = userEvent.setup();
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{
        id: "alpha",
        name: "Alpha",
        channelType: "stream",
        members: ["one", "two"],
      }}
      close={() => {}}
    >
      <button type="button">Refresh messages</button>
    </ChannelSettingsPanel>,
  );
  expect(
    screen.getByRole("complementary", { name: "Channel settings" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "Alpha" })).toBeVisible();
  expect(screen.getByText("alpha")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Canvas" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(screen.getByText("2")).toBeVisible();
  expect(screen.getByRole("tab", { name: "Channel settings" })).toHaveFocus();
  expect(screen.getByText("Refresh messages")).not.toBeVisible();
  await user.click(screen.getByText("Diagnostics"));
  expect(
    screen.getByRole("button", { name: "Refresh messages" }),
  ).toBeVisible();
});

it("closes with Escape or its close button without swallowing other keys", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={undefined}
      close={close}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  await user.keyboard("{ArrowDown}");
  expect(close).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("button", { name: "Close Channel settings tab" }),
  );
  expect(close).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("tab", { name: "Channel settings" }));
  await user.keyboard("{Delete}");
  expect(close).toHaveBeenCalledTimes(3);
});

it("does not invent unknown metadata and still exposes diagnostics without a channel", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{ id: "dm", name: "Someone", channelType: "dm" }}
      close={() => {}}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(screen.queryByText("Channel type")).not.toBeInTheDocument();
  expect(screen.queryByText("Members")).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={undefined}
      close={() => {}}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(screen.queryByText("Channel ID")).not.toBeInTheDocument();
  await user.click(screen.getByText("Diagnostics"));
  expect(screen.getByText("Diagnostics content")).toBeVisible();
});

