// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ConversationImportReview } from "./ConversationImportReview";
import { createImportReviews } from "./reviews";

afterEach(cleanup);

function pending() {
  const reviews = createImportReviews();
  let approved: boolean | undefined;
  void reviews
    .request({
      type: "consent",
      title: "Accept this import?",
      description: "Your messages will be imported.",
      facts: [],
      members: [],
      confirmLabel: "Accept",
    })
    .then((result) => {
      approved = result;
    });
  render(<ConversationImportReview reviews={reviews} />);
  return { reviews, approved: () => approved };
}

/** React reads `nativeEvent`, so a synthetic trusted click is delivered
 * straight to the button's handler, as a real pointer or key press would be. */
function trustedClick(button: HTMLElement) {
  const key = Object.keys(button).find((name) =>
    name.startsWith("__reactProps$"),
  );
  const props = key && (button as unknown as Record<string, unknown>)[key];
  (props as { onClick(event: unknown): void }).onClick({
    nativeEvent: { isTrusted: true },
  });
}

it("ignores a scripted click on approve", async () => {
  const { reviews, approved } = pending();
  const button = screen.getByRole("button", { name: "Accept" });
  fireEvent.click(button);
  await act(async () => {
    button.click();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(reviews.snapshot()).toHaveLength(1);
  expect(approved()).toBeUndefined();
});

it("approves on a trusted click", async () => {
  const { reviews, approved } = pending();
  await act(async () => {
    trustedClick(screen.getByRole("button", { name: "Accept" }));
  });
  expect(reviews.snapshot()).toHaveLength(0);
  expect(approved()).toBe(true);
});

it("cancels on any click", async () => {
  const { reviews, approved } = pending();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  });
  expect(reviews.snapshot()).toHaveLength(0);
  expect(approved()).toBe(false);
});
