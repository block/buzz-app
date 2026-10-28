// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { VideoControls } from "../../features/messages/VideoPlayer";
import { PanelDock } from "../../features/panels/PanelDock";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import type { RelaySession } from "../../features/relay/session";
import { ConversationTab } from "./ConversationTab";

// Reader/editor implementations are independent of this mounted tab's visual
// and visit policy. Keep the actual native-control and workspace owners.
vi.mock("./ChannelBody", () => ({
  ChannelBody: function Body() {
    const video = useRef<HTMLVideoElement>(null);
    return (
      <>
        <video ref={video}>
          <track kind="captions" />
        </video>
        <VideoControls videoRef={video} inline />
      </>
    );
  },
}));
vi.mock("../../features/messages/MessageComposer", () => ({
  MessageComposer: ({ shown }: { shown: boolean }) => (
    <textarea aria-label="Composer" data-shown={shown} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("publishes a direct tab through its retained dock exit without retaining its logical visit", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = HTMLElement.prototype.getAnimations;
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [{ finished }],
  });
  const channel = { id: "beta", name: "Beta", members: ["viewer"] };
  const snapshot = { status: "ready", channels: [channel] };
  const enterChannel = vi.fn(async () => {});
  const leaveChannel = vi.fn();
  const session = {
    viewer: "viewer",
    channels: { list: () => snapshot, subscribeList: () => () => {} },
    unread: { enterChannel, leaveChannel },
  } as unknown as RelaySession;
  function Workspace({ open = true, selected = "beta" }) {
    return (
      <PanelDock open={open} keepMounted className={undefined}>
        <PanelWorkspace
          value={selected}
          select={() => {}}
          items={[
            {
              id: "beta",
              label: "Beta",
              content: (
                <ConversationTab
                  tab={{ id: "beta", kind: "conversation", channelId: "beta" }}
                  active={open && selected === "beta"}
                  channel={channel}
                  session={session}
                  scope="direct-publication"
                  openLink={() => false}
                  canOpenLink={() => false}
                  openThread={() => {}}
                  close={() => {}}
                />
              ),
            },
            { id: "other", label: "Other", content: <p>Other content</p> },
          ]}
        />
      </PanelDock>
    );
  }
  try {
    const view = render(<Workspace />);
    const video = view.container.querySelector("video");
    if (!video) throw new Error("Missing native player");
    const progress = screen.getByRole("slider", { name: "Video progress" });
    const composer = screen.getByLabelText("Composer");
    Object.defineProperties(video, {
      duration: { configurable: true, value: 100 },
      paused: { configurable: true, value: false },
    });
    const pause = vi.spyOn(video, "pause");
    const play = vi.spyOn(video, "play");
    fireEvent.loadedMetadata(video);
    fireEvent.play(video);
    video.currentTime = 7;
    fireEvent.timeUpdate(video);
    expect(progress).toHaveValue("7");
    expect(enterChannel).toHaveBeenCalledExactlyOnceWith("beta");

    view.rerender(<Workspace open={false} />);
    expect(video.closest("[data-closing]")).not.toBeNull();
    expect(video.closest("[hidden]")).toBeNull();
    expect(leaveChannel).toHaveBeenCalledExactlyOnceWith("beta");
    expect(composer).toHaveAttribute("data-shown", "false");
    video.currentTime = 17;
    fireEvent.timeUpdate(video);
    expect(progress).toHaveValue("17");

    await act(async () => finish());
    expect(video.closest("[hidden]")).not.toBeNull();
    video.currentTime = 31;
    fireEvent.timeUpdate(video);
    act(() => vi.advanceTimersByTime(32));
    expect(progress).toHaveValue("17");
    view.rerender(<Workspace />);
    // Current native time is published before a new animation frame.
    expect(progress).toHaveValue("31");
    expect(composer).toHaveAttribute("data-shown", "true");
    expect(enterChannel).toHaveBeenCalledTimes(2);

    view.rerender(<Workspace selected="other" />);
    video.currentTime = 43;
    fireEvent.timeUpdate(video);
    expect(progress).toHaveValue("31");
    view.rerender(<Workspace />);
    expect(progress).toHaveValue("43");
    expect(view.container.querySelector("video")).toBe(video);
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    view.unmount();
    expect(video.isConnected).toBe(false);
  } finally {
    finish();
    if (original) HTMLElement.prototype.getAnimations = original;
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  }
});
