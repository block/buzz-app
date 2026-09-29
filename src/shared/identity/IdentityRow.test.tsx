// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { ToastProvider } from "../design-system/ui/Toast";
import { IdentityRow } from "./IdentityRow";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const pubkey = "ab".repeat(32);

it("loads supplemental evidence only during the preview lifetime and copies the full npub without activating the row", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const mount = vi.fn();
  const dispose = vi.fn();
  const add = vi.fn();
  function Evidence() {
    useEffect(() => {
      mount();
      return dispose;
    }, []);
    return <span>Managed by Morgan</span>;
  }
  const view = render(
    <ToastProvider>
      <IdentityRow
        pubkey={pubkey}
        name="Agent"
        isAgent
        previewDetail={<Evidence />}
        render={(content) => (
          <button type="button" onClick={add}>
            {content}
          </button>
        )}
      />
    </ToastProvider>,
  );
  expect(mount).not.toHaveBeenCalled();
  await user.hover(screen.getByRole("button", { name: /Agent/ }));
  const card = await screen.findByRole("dialog", { name: "Agent identity" });
  expect(card).toHaveTextContent(npubEncode(pubkey));
  expect(card).toHaveTextContent("Managed by Morgan");
  expect(mount).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith(npubEncode(pubkey)));
  expect(await screen.findByText("Copied npub")).toBeVisible();
  expect(add).not.toHaveBeenCalled();
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
});

it("reports clipboard denial and leaves the full key available for manual copy", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new Error("denied"),
  );
  render(
    <ToastProvider>
      <IdentityRow pubkey={pubkey} name="Morgan" />
    </ToastProvider>,
  );
  await user.tab();
  const card = await screen.findByRole("dialog", { name: "Morgan identity" });
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  expect(
    await screen.findByText("Couldn’t copy npub. Select the text to copy it."),
  ).toBeVisible();
  expect(card).toHaveTextContent(npubEncode(pubkey));
  expect(screen.queryByText("Copied npub")).not.toBeInTheDocument();
});
