// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CopyLabel, useCopyFeedback } from "./CopyFeedback";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A labelled copy button with no icon, wired as a control wires it. `ended`
 * collects what each `copy` resolved to. `reportsRefusal` is off where the
 * control reports a refusal somewhere else. */
function Control({
  write,
  ended,
  reportsRefusal = true,
}: {
  write: () => unknown;
  ended: unknown[];
  reportsRefusal?: boolean;
}) {
  const { copied, failed, copy, status } = useCopyFeedback({ reportsRefusal });
  return (
    <>
      <button
        type="button"
        aria-label="Copy URL"
        onClick={() => void copy(write).then((end) => ended.push(end))}
      >
        <CopyLabel label="Copy URL" copied={copied} failed={failed} />
      </button>
      {status}
    </>
  );
}

/** A write the test finishes when it chooses. */
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const button = () => screen.getByRole("button", { name: "Copy URL" });
const denied = () => new DOMException("denied", "NotAllowedError");

it("starts the write inside the click, and fills the status that was in place before it", async () => {
  const write = deferred();
  const start = vi.fn(() => write.promise);
  const ended: unknown[] = [];
  render(<Control write={start} ended={ended} />);
  // The status is in the page, empty, before the button is pressed: a fast
  // write must not fill a region that was only just added.
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  vi.useFakeTimers();
  try {
    // Not `act(async …)`: the write must have begun by the time the click
    // returns, while the browser still counts the click as the user's.
    act(() => {
      fireEvent.click(button());
      expect(start).toHaveBeenCalledOnce();
    });
    expect(button()).toHaveTextContent(/^Copy URL$/);
    expect(status).toBeEmptyDOMElement();
    expect(ended).toEqual([]);

    await act(async () => write.resolve());
    expect(ended).toEqual(["copied"]);
    // The same element, not a new one in its place.
    expect(status).toHaveTextContent(/^Copied$/);
    act(() => vi.advanceTimersByTime(1500));
    // The status stays, empty, for the next result.
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByRole("status")).toBe(status);
  } finally {
    write.resolve();
  }
});

it("shows a label-only button's copy and refusal in the button, under the same name", async () => {
  const start = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(denied());
  render(<Control write={start} ended={[]} />);

  await act(async () => fireEvent.click(button()));
  expect(button()).toHaveTextContent(/^Copied$/);
  expect(button()).toHaveAccessibleName("Copy URL");

  await act(async () => fireEvent.click(button()));
  expect(button()).toHaveTextContent(/^Couldn’t copy$/);
  expect(button()).toHaveAccessibleName("Copy URL");
  expect(screen.getByRole("status")).toHaveTextContent(/^Couldn’t copy$/);
});

it("resolves each attempt to how it ended, and a superseded one to nothing", async () => {
  const first = deferred();
  const start = vi
    .fn<() => unknown>()
    .mockReturnValueOnce(first.promise)
    .mockRejectedValueOnce(denied())
    .mockImplementationOnce(() => {
      throw denied();
    });
  const ended: unknown[] = [];
  render(<Control write={start} ended={ended} reportsRefusal={false} />);
  try {
    await act(async () => fireEvent.click(button()));
    await act(async () => fireEvent.click(button()));
    expect(ended).toEqual(["failed"]);
    // This control reports the refusal elsewhere: its button and status
    // say nothing.
    expect(button()).toHaveTextContent(/^Copy URL$/);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    // The first write lands late. Its caller hears nothing, so it cannot
    // report over the newer attempt, and the button does not show it.
    await act(async () => first.resolve());
    expect(ended).toEqual(["failed", undefined]);
    expect(button()).toHaveTextContent(/^Copy URL$/);

    // A write that throws before it returns a promise is a refusal too.
    await act(async () => fireEvent.click(button()));
    expect(ended).toEqual(["failed", undefined, "failed"]);
  } finally {
    first.resolve();
  }
});
