// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
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

it("opens Canvas from its own keyboard-accessible row before setup actions", async () => {
  const user = userEvent.setup();
  const openCanvas = vi.fn();
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{ id: "alpha", name: "Alpha", channelType: "stream" }}
      close={() => {}}
      openCanvas={openCanvas}
      setupTools={<button type="button">Leave channel</button>}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  const canvas = screen.getByRole("button", { name: "Canvas" });
  expect(canvas).toHaveAttribute("aria-haspopup", "dialog");
  expect(canvas).not.toHaveTextContent("Shared notes and plans");
  expect(openCanvas).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Channel settings" })).toHaveFocus();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Close Channel settings tab" }),
  ).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Copy channel id" })).toHaveFocus();
  await user.tab();
  expect(canvas).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(openCanvas).toHaveBeenCalledTimes(1);
  expect(openCanvas).toHaveBeenLastCalledWith(canvas);
  await user.tab();
  expect(screen.getByRole("button", { name: "Leave channel" })).toHaveFocus();
  await user.click(canvas);
  expect(openCanvas).toHaveBeenCalledTimes(2);
});

it("omits Canvas without a writable channel or an opener", () => {
  const channel = { id: "alpha", name: "Alpha" };
  const { rerender } = render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={channel}
      close={() => {}}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(
    screen.queryByRole("button", { name: "Canvas" }),
  ).not.toBeInTheDocument();
  for (const unavailable of [
    undefined,
    { ...channel, readOnly: true as const },
  ]) {
    rerender(
      <ChannelSettingsPanel
        scope="community:viewer"
        channel={unavailable}
        close={() => {}}
        openCanvas={() => {}}
      >
        Diagnostics content
      </ChannelSettingsPanel>,
    );
    expect(
      screen.queryByRole("button", { name: "Canvas" }),
    ).not.toBeInTheDocument();
  }
});

const head = signed(keypair(), {
  kind: 40100,
  content: "# Google root-link preview submission deep dive",
  tags: [["h", "alpha"]],
});
function previewFixture() {
  return {
    available: true,
    read: vi.fn<ChannelCanvas["read"]>().mockResolvedValue(head),
    save: vi.fn<ChannelCanvas["save"]>(),
  };
}
function panel(
  canvas: ChannelCanvas,
  id = "alpha",
  canvasOpen = false,
  readOnly?: true,
) {
  return (
    <ChannelSettingsPanel
      scope="community:viewer"
      canvas={canvas}
      channel={{ id, name: id, ...(readOnly ? { readOnly } : {}) }}
      canvasOpen={canvasOpen}
      openCanvas={() => {}}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>
  );
}

it("shows Canvas as the first line and saved plain text as the secondary preview", async () => {
  const canvas = previewFixture();
  const { container } = render(panel(canvas));
  expect(screen.getByText("Loading preview…")).toBeVisible();
  await screen.findByText("Google root-link preview submission deep dive");
  const row = screen.getByRole("button", { name: "Canvas" });
  expect(row).toHaveAccessibleDescription(
    "Google root-link preview submission deep dive",
  );
  expect(row.querySelector(".buzz-choice-row-label")).toHaveTextContent(
    /^Canvas$/,
  );
  expect(row.querySelector(".buzz-choice-row-description")).toHaveTextContent(
    "Google root-link preview submission deep dive",
  );
  expect(canvas.read).toHaveBeenCalledWith("alpha");
  expect(canvas.save).not.toHaveBeenCalled();
  expect(container.querySelector("img, script")).toBeNull();
});

it.each([
  undefined,
  { ...head, content: "   \n" },
  { ...head, content: "<!-- comment -->" },
])("uses neutral empty copy for %j", async (event) => {
  const canvas = previewFixture();
  canvas.read.mockResolvedValue(event);
  render(panel(canvas));
  expect(await screen.findByText("No content yet")).toBeVisible();
  expect(screen.getByRole("button", { name: "Canvas" })).toBeEnabled();
});

it("keeps a failed preview openable and refreshes saved content after closing the editor", async () => {
  const canvas = previewFixture();
  canvas.read.mockRejectedValueOnce(new Error("Offline"));
  const { rerender } = render(panel(canvas));
  expect(
    await screen.findByText("Preview unavailable. Open to retry."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Canvas" })).toBeEnabled();
  rerender(panel(canvas, "alpha", true));
  expect(canvas.read).toHaveBeenCalledTimes(1);
  rerender(panel(canvas));
  expect(
    await screen.findByText("Google root-link preview submission deep dive"),
  ).toBeVisible();
  rerender(panel(canvas, "alpha", true));
  canvas.read.mockResolvedValue({ ...head, content: "# Updated document" });
  rerender(panel(canvas));
  expect(await screen.findByText("Updated document")).toBeVisible();
  expect(canvas.save).not.toHaveBeenCalled();
});

it("ignores an old channel's pending preview and hides content immediately on scope or access changes", async () => {
  const canvas = previewFixture();
  let release!: (event: typeof head) => void;
  canvas.read.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const { rerender } = render(panel(canvas));
  try {
    canvas.read.mockResolvedValue({ ...head, content: "# Beta document" });
    rerender(panel(canvas, "beta"));
    expect(await screen.findByText("Beta document")).toBeVisible();
  } finally {
    await act(async () => release(head));
  }
  expect(
    screen.queryByText("Google root-link preview submission deep dive"),
  ).not.toBeInTheDocument();
  const otherCommunity = previewFixture();
  otherCommunity.read.mockResolvedValue(undefined);
  rerender(panel(otherCommunity, "beta"));
  expect(screen.queryByText("Beta document")).not.toBeInTheDocument();
  expect(await screen.findByText("No content yet")).toBeVisible();
  rerender(panel(otherCommunity, "beta", false, true));
  expect(
    screen.queryByRole("button", { name: /^Canvas/ }),
  ).not.toBeInTheDocument();
  await waitFor(() => expect(otherCommunity.read).toHaveBeenCalledTimes(1));
});

it("replaces a saved preview with loading and failure states during refresh", async () => {
  const canvas = previewFixture();
  const { rerender } = render(panel(canvas));
  await screen.findByText("Google root-link preview submission deep dive");
  rerender(panel(canvas, "alpha", true));
  let reject!: (error: Error) => void;
  canvas.read.mockReturnValueOnce(
    new Promise((_, rejectRead) => {
      reject = rejectRead;
    }),
  );
  try {
    rerender(panel(canvas));
    expect(canvas.read).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Loading preview…")).toBeVisible();
    expect(
      screen.queryByText("Google root-link preview submission deep dive"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Canvas" }),
    ).toHaveAccessibleDescription("Loading preview…");
  } finally {
    await act(async () => reject(new Error("Offline")));
  }
  expect(screen.getByText("Preview unavailable. Open to retry.")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Canvas" }),
  ).toHaveAccessibleDescription("Preview unavailable. Open to retry.");
  expect(screen.getByRole("button", { name: "Canvas" })).toBeEnabled();
  expect(
    screen.queryByText("Google root-link preview submission deep dive"),
  ).not.toBeInTheDocument();
  expect(canvas.save).not.toHaveBeenCalled();
});

it("opens even an empty members list without an Edit ingress", async () => {
  const openMembers = vi.fn();
  const user = userEvent.setup();
  render(
    <ChannelSettingsPanel
      channel={{ id: "alpha", name: "Alpha", members: [] }}
      openMembers={openMembers}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  const members = screen.getByRole("button", { name: "View members" });
  expect(members).toHaveAccessibleDescription("0");
  expect(members).not.toHaveTextContent("Edit");
  expect(members.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  members.focus();
  await user.keyboard("{Enter}");
  expect(openMembers).toHaveBeenCalledWith(members);
});

function idPanel(id = "11111111-1111-4111-8111-111111111111") {
  return (
    <ChannelSettingsPanel channel={{ id, name: "Alpha" }} close={() => {}}>
      Diagnostics
    </ChannelSettingsPanel>
  );
}

it("copies the exact channel ID with keyboard access and reports success", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(idPanel());
  const copy = screen.getByRole("button", { name: "Copy channel id" });
  expect(copy).toHaveAttribute("aria-haspopup", "false");
  expect(copy).toHaveTextContent("Copy");
  copy.focus();
  await user.keyboard("{Enter}");
  expect(write).toHaveBeenCalledExactlyOnceWith(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Channel ID copied",
  );
  expect(copy).toHaveFocus();
});

it("keeps the ID visible after clipboard denial and supports retry", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue();
  render(idPanel("alpha"));
  const copy = screen.getByRole("button", { name: "Copy channel id" });
  await user.click(copy);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Couldn’t copy channel ID. Try again.",
  );
  expect(screen.getByText("alpha")).toBeVisible();
  expect(copy).toBeEnabled();
  await user.click(copy);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Channel ID copied",
  );
  expect(screen.getByRole("tooltip")).not.toHaveTextContent("Couldn’t");
  expect(write).toHaveBeenCalledTimes(2);
});

it("reports an unavailable clipboard without throwing", async () => {
  const user = userEvent.setup();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  if (!descriptor) throw new Error("Missing clipboard test stub");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  try {
    render(idPanel());
    await user.click(screen.getByRole("button", { name: "Copy channel id" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Couldn’t copy channel ID.",
    );
  } finally {
    Object.defineProperty(navigator, "clipboard", descriptor);
  }
});

it.each(["resolve", "reject"])(
  "does not show stale copy feedback after changing channels (%s)",
  async (outcome) => {
    const user = userEvent.setup();
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValueOnce(pending)
      .mockResolvedValue();
    const { rerender } = render(idPanel("alpha"));
    await user.click(screen.getByRole("button", { name: "Copy channel id" }));
    try {
      expect(
        screen.getByRole("button", { name: "Copy channel id" }),
      ).toHaveAttribute("aria-disabled", "true");
      rerender(idPanel("beta"));
      expect(
        screen.getByRole("button", { name: "Copy channel id" }),
      ).toBeEnabled();
    } finally {
      await act(async () =>
        outcome === "resolve" ? resolve() : reject(new Error("denied")),
      );
    }
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy channel id" }));
    expect(write).toHaveBeenLastCalledWith("beta");
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Channel ID copied",
    );
  },
);
