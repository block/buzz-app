// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { TabSlot, useTabNodes } from "../../bundled/channels/TabHosts";
import { PanelWorkspace, PanelLocalTab } from "../panels/PanelWorkspace";
import { PanelDock } from "../panels/PanelDock";
import { RetainedWorkspacePresentation } from "../panels/WorkspacePresentation";
import { VideoControls } from "./VideoPlayer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function Player({ label = "Clock" }: { label?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  return (
    <div data-clock={label}>
      <video ref={video} aria-label={label}>
        <track kind="captions" />
      </video>
      <VideoControls videoRef={video} inline />
    </div>
  );
}

function start(video: HTMLVideoElement) {
  Object.defineProperties(video, {
    duration: { configurable: true, value: 100 },
    paused: { configurable: true, value: false },
  });
  const pause = vi.spyOn(video, "pause");
  const play = vi.spyOn(video, "play");
  fireEvent.loadedMetadata(video);
  fireEvent.play(video);
  return { pause, play };
}

function progress(container: HTMLElement, label = "Clock") {
  const input = container.querySelector<HTMLInputElement>(
    `[data-clock="${label}"] input[aria-label="Video progress"]`,
  );
  if (!input) throw new Error("Missing progress control");
  return input;
}

it("retains a covered portal's clock, publishes current native time on activation, and disposes on close", () => {
  vi.useFakeTimers();
  function Workspace({ moved = false, closed = false }) {
    const [selected, select] = useState("player");
    const nodes = useTabNodes(closed ? [] : ["player"]);
    const node = nodes.get("player");
    const items = node
      ? [
          { id: "player", label: "Player", content: <TabSlot node={node} /> },
          {
            id: "other",
            label: "Other",
            content: <input aria-label="Draft" />,
          },
        ]
      : [];
    return (
      <>
        {moved && (
          <PanelWorkspace items={items} value={selected} select={select} />
        )}
        <PanelDock open={!moved} className={undefined}>
          {!moved && (
            <PanelWorkspace items={items} value={selected} select={select} />
          )}
        </PanelDock>
        {node &&
          createPortal(
            <RetainedWorkspacePresentation target={node}>
              <Player />
            </RetainedWorkspacePresentation>,
            node,
          )}
      </>
    );
  }
  const view = render(<Workspace />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing player");
  const { pause, play } = start(video);
  video.currentTime = 7;
  fireEvent.timeUpdate(video);
  expect(progress(view.container)).toHaveValue("7");
  fireEvent.click(screen.getByRole("tab", { name: "Other" }));
  video.currentTime = 19;
  fireEvent.timeUpdate(video);
  act(() => vi.advanceTimersByTime(32));
  expect(progress(view.container)).toHaveValue("7");
  act(() =>
    window.dispatchEvent(
      new CustomEvent("buzz:video-playback-speed", { detail: 1.5 }),
    ),
  );
  expect(video.playbackRate).toBe(1.5);
  fireEvent.click(screen.getByRole("tab", { name: "Player" }));
  // No animation-frame tick is needed to publish the restored current time.
  expect(progress(view.container)).toHaveValue("19");
  view.rerender(<Workspace moved />);
  expect(view.container.querySelector("video")).toBe(video);
  expect(progress(view.container)).toHaveValue("19");
  expect(pause).not.toHaveBeenCalled();
  expect(play).not.toHaveBeenCalled();
  view.rerender(<Workspace moved closed />);
  expect(video.isConnected).toBe(false);
  act(() => vi.advanceTimersByTime(32));
  expect(vi.getTimerCount()).toBe(0);
});

it("publishes a local detail at its destination while its origin is covered", () => {
  vi.useFakeTimers();
  function Origin() {
    const [detail, showDetail] = useState(false);
    return (
      <>
        <Player label="Origin" />
        <button type="button" onClick={() => showDetail(true)}>
          Open detail
        </button>
        {detail && (
          <PanelLocalTab title="Detail" close={() => showDetail(false)}>
            <Player label="Detail" />
          </PanelLocalTab>
        )}
      </>
    );
  }
  const view = render(
    <PanelWorkspace
      items={[{ id: "origin", label: "Origin", content: <Origin /> }]}
      value="origin"
      select={() => {}}
    />,
  );
  const origin = view.container.querySelector<HTMLVideoElement>(
    'video[aria-label="Origin"]',
  );
  if (!origin) throw new Error("Missing origin");
  start(origin);
  origin.currentTime = 3;
  fireEvent.timeUpdate(origin);
  fireEvent.click(screen.getByRole("button", { name: "Open detail" }));
  const detail = view.container.querySelector<HTMLVideoElement>(
    'video[aria-label="Detail"]',
  );
  if (!detail) throw new Error("Missing detail");
  start(detail);
  origin.currentTime = 11;
  detail.currentTime = 23;
  fireEvent.timeUpdate(origin);
  fireEvent.timeUpdate(detail);
  expect(progress(view.container, "Origin")).toHaveValue("3");
  expect(progress(view.container, "Detail")).toHaveValue("23");
});

it("keeps publishing an outgoing pane until its visible push animation ends", () => {
  vi.useFakeTimers();
  function Workspace() {
    const [selected, select] = useState("player");
    return (
      <PanelWorkspace
        main
        value={selected}
        select={select}
        items={[
          { id: "player", label: "Player", content: <Player /> },
          {
            id: "other",
            label: "Other",
            close() {},
            content: <input aria-label="Draft" />,
          },
        ]}
      />
    );
  }
  const view = render(<Workspace />);
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing player");
  start(video);
  fireEvent.click(screen.getByRole("tab", { name: "Other" }));
  expect(video.closest("[data-leaving]")).not.toBeNull();
  video.currentTime = 13;
  fireEvent.timeUpdate(video);
  expect(progress(view.container)).toHaveValue("13");
  const entering = view.container.querySelector("[data-entering]");
  if (!entering) throw new Error("Missing incoming pane");
  fireEvent(entering, new Event("webkitAnimationEnd", { bubbles: true }));
  expect(entering).not.toHaveAttribute("data-entering");
  video.currentTime = 29;
  fireEvent.timeUpdate(video);
  expect(progress(view.container)).toHaveValue("13");
  fireEvent.click(screen.getByRole("tab", { name: "Player" }));
  expect(progress(view.container)).toHaveValue("29");
});

it("retires publication after a kept dock's visible exit and resumes on reopening", async () => {
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
  const view = render(
    <PanelDock open keepMounted className={undefined}>
      <Player />
    </PanelDock>,
  );
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing player");
  try {
    start(video);
    view.rerender(
      <PanelDock open={false} keepMounted className={undefined}>
        <Player />
      </PanelDock>,
    );
    video.currentTime = 17;
    fireEvent.timeUpdate(video);
    expect(progress(view.container)).toHaveValue("17");
    await act(async () => finish());
    expect(video.closest("[hidden]")).not.toBeNull();
    video.currentTime = 31;
    fireEvent.timeUpdate(video);
    expect(progress(view.container)).toHaveValue("17");
    view.rerender(
      <PanelDock open keepMounted className={undefined}>
        <Player />
      </PanelDock>,
    );
    expect(progress(view.container)).toHaveValue("31");
  } finally {
    finish();
    if (original) HTMLElement.prototype.getAnimations = original;
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  }
});
