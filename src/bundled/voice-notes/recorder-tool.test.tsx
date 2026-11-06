// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComposerToolProps } from "../../features/conversation/contracts";
import type { AttachmentDraft } from "../../features/messages/attachment-draft";
import { useVoiceCapture } from "../../features/messages/useVoiceCapture";
import { voiceRecorderTool } from "./recorder-tool";

const Recorder = voiceRecorderTool.component;
const track = { stop: vi.fn(), kind: "audio" };
const getUserMedia = vi.fn();

beforeEach(() => {
  track.stop.mockReset();
  getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [track] });
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } });
  class Recorder extends EventTarget {
    state = "inactive";
    static isTypeSupported = () => true;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.dispatchEvent(new Event("stop"));
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      createAnalyser = () => ({ fftSize: 0, smoothingTimeConstant: 0 });
      createMediaStreamSource = () => ({ connect: () => {} });
      close = async () => {};
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const store = {
  snapshot: () => [],
  subscribe: () => () => {},
  add: vi.fn(),
} as unknown as AttachmentDraft;
const session = { attachments: {} } as never;
const unused = (): never => {
  throw new Error("unused");
};

/** The host: it mounts the capture the tool starts, outside the tool. */
function Host({ tool }: { tool: boolean }) {
  const voice = useVoiceCapture(store, false, () => {});
  return (
    <>
      {tool && (
        <Recorder
          {...({
            session,
            scope: "scope",
            channelId: "channel",
            disabled: false,
            recipients: [],
            insertText: unused,
            insertMention: unused,
            insertMentions: unused,
            replaceRecipients: unused,
            insertResource: unused,
            openTarget: () => false,
            capture: voice.begin,
            focus: () => {},
          } as unknown as ComposerToolProps)}
        />
      )}
      {voice.element}
      <output data-testid="state">
        {voice.capturing ? "capturing" : "idle"}
      </output>
    </>
  );
}

it("cancels its recording and releases the microphone when the contribution goes away", async () => {
  let remove!: () => void;
  function View() {
    const [tool, setTool] = useState(true);
    remove = () => setTool(false);
    return <Host tool={tool} />;
  }
  render(<View />);
  fireEvent.click(screen.getByRole("button", { name: "Record voice note" }));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("state").textContent).toBe("capturing");
  // The plugin is disabled: the button unmounts, and with it the recording
  // the host was showing on its behalf.
  act(() => remove());
  expect(screen.getByTestId("state").textContent).toBe("idle");
  expect(track.stop).toHaveBeenCalled();
  expect(store.add).not.toHaveBeenCalled();
});
