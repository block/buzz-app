// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { InviteNotice } from "./HuddleCapsule";

afterEach(cleanup);

it.each([
  [undefined, undefined, undefined],
  [
    "unavailable" as const,
    undefined,
    "Atlas isn’t available for voice right now.",
  ],
  ["room" as const, undefined, "Buzz couldn’t verify the Huddle room."],
  [undefined, "You don’t have permission.", "You don’t have permission."],
])(
  "offers to add the agent again when Buzz couldn’t (reason: %s, refusal: %s)",
  async (reason, refusal, description) => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ToastProvider>
        <InviteNotice
          agent="Atlas"
          reason={reason}
          refusal={refusal}
          onRetry={onRetry}
          onDismiss={onDismiss}
        />
      </ToastProvider>,
    );
    const notice = await screen.findByRole("dialog", {
      name: "Couldn’t add Atlas to the Huddle",
    });
    expect(notice).toBeVisible();
    // The body is only a known cause; Try again says the rest.
    if (description) expect(notice).toHaveAccessibleDescription(description);
    else expect(notice).not.toHaveAttribute("aria-describedby");
    expect(
      screen.queryByText(
        /You can still talk|Try adding|Agent voice stopped|Error:/,
      ),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss the problem adding Atlas" }),
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
  },
);
