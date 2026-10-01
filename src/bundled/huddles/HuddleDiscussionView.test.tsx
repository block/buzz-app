// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HuddleDiscussionView } from "./HuddleDiscussionView";
import type { HuddleDiscussion } from "../../features/huddle/discussion";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function discussion(delivery: "failed" | "unknown"): HuddleDiscussion {
  return {
    version: 0,
    historyLimited: false,
    status: "ready",
    writable: true,
    sending: false,
    sent: 0,
    hasMore: false,
    rows: [
      {
        id: "message",
        author: "Alex",
        picture: null,
        text: "Hello",
        time: 1,
        delivery,
      },
    ],
  };
}

it.each(["failed", "unknown"] as const)(
  "keeps focus when recovering a %s message succeeds or fails",
  (delivery) => {
    let value = discussion(delivery);
    const recover = vi.fn((_id: string, dismiss?: boolean) => {
      value = {
        ...value,
        rows: dismiss
          ? []
          : value.rows.map((row) => ({ ...row, delivery: "sending" })),
      };
      rerender(view());
    });
    const view = () => (
      <HuddleDiscussionView
        discussion={value}
        composer={<textarea aria-label="Message this Huddle" />}
        older={() => {}}
        retry={() => {}}
        recover={recover}
      />
    );
    const { rerender } = render(view());
    if (delivery === "unknown")
      expect(screen.getByRole("status").textContent).toContain(
        "Retry sends the same message",
      );
    const editor = screen.getByRole("textbox");
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(recover).toHaveBeenCalledWith("message");
    expect(document.activeElement).toBe(editor);
    // The same row returning to failed must not steal the restored focus.
    value = discussion(delivery);
    rerender(view());
    expect(document.activeElement).toBe(editor);
    const discard = screen.getByRole("button", { name: "Discard" });
    discard.focus();
    fireEvent.click(discard);
    expect(recover).toHaveBeenLastCalledWith("message", true);
    expect(document.activeElement).toBe(editor);
    expect(screen.queryByText("Hello")).toBeNull();
  },
);

it("hands focus to the message log when discarding in a read-only room", () => {
  let value = { ...discussion("unknown"), writable: false };
  const view = () => (
    <HuddleDiscussionView
      discussion={value}
      composer={null}
      older={() => {}}
      retry={() => {}}
      recover={() => {
        value = { ...value, rows: [] };
        rerender(view());
      }}
    />
  );
  const { rerender } = render(view());
  const discard = screen.getByRole("button", { name: "Discard" });
  discard.focus();
  fireEvent.click(discard);
  expect(document.activeElement).toBe(screen.getByRole("log"));
});

it("keeps a surviving focus target across load retry success and failure", () => {
  let value: HuddleDiscussion = {
    ...discussion("failed"),
    writable: false,
    error: "Couldn’t load",
    status: "error" as HuddleDiscussion["status"],
    rows: [],
  };
  const view = () => (
    <HuddleDiscussionView
      discussion={value}
      composer={<textarea aria-label="Message this Huddle" />}
      older={() => {}}
      recover={() => {}}
      retry={() => {
        value = { ...value, error: undefined, status: "loading" };
        rerender(view());
      }}
    />
  );
  const { rerender } = render(view());
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  const log = screen.getByRole("log");
  expect(document.activeElement).toBe(log);
  value = { ...value, error: "Still unavailable", status: "error" };
  rerender(view());
  expect(document.activeElement).toBe(log);
  value = { ...value, error: undefined, status: "ready", writable: true };
  rerender(view());
  expect(document.activeElement).toBe(log);
});
