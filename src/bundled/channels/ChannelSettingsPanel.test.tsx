// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";

afterEach(cleanup);

it("shows known channel details with diagnostics collapsed until requested", async () => {
  const user = userEvent.setup();
  render(
    <ChannelSettingsPanel
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
  expect(screen.getByText("2")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Close channel settings" }),
  ).toHaveFocus();
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
    <ChannelSettingsPanel channel={undefined} close={close}>
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  await user.keyboard("{ArrowDown}");
  expect(close).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("button", { name: "Close channel settings" }),
  );
  expect(close).toHaveBeenCalledTimes(2);
});

it("does not invent unknown metadata and still exposes diagnostics without a channel", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <ChannelSettingsPanel
      channel={{ id: "dm", name: "Someone", channelType: "dm" }}
      close={() => {}}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(screen.getByText("Direct message")).toBeVisible();
  expect(screen.queryByText("Members")).not.toBeInTheDocument();
  rerender(
    <ChannelSettingsPanel channel={undefined} close={() => {}}>
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(screen.queryByText("Channel ID")).not.toBeInTheDocument();
  await user.click(screen.getByText("Diagnostics"));
  expect(screen.getByText("Diagnostics content")).toBeVisible();
});
