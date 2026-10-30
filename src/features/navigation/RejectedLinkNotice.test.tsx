// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createRejectedLinks } from "./deep-links";
import { RejectedLinkNotice } from "./RejectedLinkNotice";

afterEach(cleanup);

it("shows one notice per rejected link, replacing a repeat, until dismissed", async () => {
  const links = createRejectedLinks();
  render(
    <ToastProvider>
      <RejectedLinkNotice links={links} />
    </ToastProvider>,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => links.reject());
  await screen.findByRole("dialog", { name: "This link doesn’t work" });
  act(() => links.reject());
  await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() => expect(links.snapshot()).toBeUndefined());
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
