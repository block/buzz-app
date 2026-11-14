// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMessageReplyHold, type ReplyHold } from "./use-message-reply-hold";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Message({ reply }: { reply(): ReplyHold }) {
  const gesture = useMessageReplyHold("message", reply);
  return <div {...gesture}>Hold this message</div>;
}

it.each(["pending", "preview"])(
  "Escape cancels a %s hold before release and allows another reply",
  (phase) => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const cancel = vi.fn();
    const reply = vi.fn(() => ({ commit, cancel }));
    render(<Message reply={reply} />);
    const message = screen.getByText("Hold this message");
    const pointer = (type: "pointerdown" | "pointerup") =>
      fireEvent(
        message,
        Object.assign(
          new MouseEvent(type, {
            bubbles: true,
            button: 0,
          }),
          { pointerId: 1, isPrimary: true },
        ),
      );
    pointer("pointerdown");
    if (phase === "preview") act(() => vi.advanceTimersByTime(100));

    // The hold has not moved focus into the composer. Escape must still win.
    fireEvent.keyDown(document.body, { key: "Escape" });
    act(() => vi.advanceTimersByTime(1000));
    pointer("pointerup");
    expect(reply).toHaveBeenCalledTimes(phase === "preview" ? 1 : 0);
    expect(cancel).toHaveBeenCalledTimes(phase === "preview" ? 1 : 0);
    expect(commit).not.toHaveBeenCalled();

    pointer("pointerdown");
    act(() => vi.advanceTimersByTime(100));
    pointer("pointerup");
    expect(commit).toHaveBeenCalledTimes(1);
  },
);
