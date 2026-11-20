// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { SPRING_LOAD_DELAY_MS } from "../../features/messages/spring-loaded-drag";
import { ChannelSidebarRow } from "./ChannelSidebarRow";

afterEach(cleanup);
it("offers a separate hide action only for DM rows", async () => {
  const onHideDm = vi.fn();
  const onSelect = vi.fn();
  render(
    <ChannelSidebarRow
      channel={{ id: "dm", name: "Alice", channelType: "dm" }}
      icon={<svg />}
      onSelect={onSelect}
      onPrepare={() => {}}
      onHideDm={onHideDm}
    />,
  );
  const remove = screen.getByRole("button", {
    name: "Remove Alice from DMs",
  });
  expect(remove).not.toHaveAttribute("title");
  await userEvent.setup().click(remove);
  expect(onHideDm).toHaveBeenCalledWith("dm");
  expect(onSelect).not.toHaveBeenCalled();
});
it("keeps focus in the sidebar when removing its last visible DM", async () => {
  function OnlyDm() {
    const [visible, setVisible] = useState(true);
    return (
      <div>
        <div data-sidebar-section="">
          <details open>
            <summary>Channels</summary>
          </details>
        </div>
        {visible && (
          <div data-sidebar-section="">
            <details open>
              <summary>DMs</summary>
            </details>
            <ChannelSidebarRow
              channel={{ id: "dm", name: "Alice", channelType: "dm" }}
              icon={<svg />}
              onSelect={() => {}}
              onPrepare={() => {}}
              onHideDm={() => setVisible(false)}
            />
          </div>
        )}
      </div>
    );
  }
  render(<OnlyDm />);
  const remove = screen.getByRole("button", { name: "Remove Alice from DMs" });
  remove.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(screen.queryByText("DMs")).not.toBeInTheDocument();
  expect(screen.getByText("Channels")).toHaveFocus();
});

it("skips an exiting neighbor when removing a DM", async () => {
  render(
    <div data-sidebar-section="dms">
      <ChannelSidebarRow
        channel={{ id: "alice", name: "Alice", channelType: "dm" }}
        icon={<svg />}
        onSelect={() => {}}
        onPrepare={() => {}}
        onHideDm={() => {}}
      />
      <div inert>
        <button type="button" data-channel-id="bob">
          Leaving Bob
        </button>
      </div>
      <button type="button" data-channel-id="bob">
        Bob
      </button>
    </div>,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Remove Alice from DMs" }),
  );
  expect(screen.getByRole("button", { name: "Bob" })).toHaveFocus();
});

it("opens its conversation when a file drag rests on it, unless already open", () => {
  vi.useFakeTimers();
  try {
    const onSelect = vi.fn();
    const files = { dataTransfer: { types: ["Files"] } };
    const view = render(
      <ChannelSidebarRow
        channel={{ id: "general", name: "General", channelType: "stream" }}
        icon={<svg />}
        onSelect={onSelect}
        onPrepare={() => {}}
      />,
    );
    const row = screen.getByRole("button", { name: "General" });
    fireEvent.dragEnter(row, { dataTransfer: { types: ["text/plain"] } });
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.dragEnter(row, files);
    expect(row).toHaveAttribute("data-spring-loaded", "hover");
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("general");
    fireEvent.dragLeave(row, files);
    view.rerender(
      <ChannelSidebarRow
        channel={{ id: "general", name: "General", channelType: "stream" }}
        icon={<svg />}
        selected="general"
        onSelect={onSelect}
        onPrepare={() => {}}
      />,
    );
    fireEvent.dragEnter(row, files);
    expect(row).not.toHaveAttribute("data-spring-loaded");
    vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS);
    expect(onSelect).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
