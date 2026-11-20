// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageViewer } from "./ImageViewer";

afterEach(cleanup);

it("shows an https image in the fullscreen viewer and closes on request", async () => {
  const onClose = vi.fn();
  render(
    <ImageViewer
      src="https://fixture.test/screenshot.png"
      name="screenshot.png"
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Image viewer" });
  expect(dialog).toHaveTextContent("screenshot.png");
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/screenshot.png",
  );
  expect(
    screen.getByRole("link", { name: "Open image in browser" }),
  ).toHaveAttribute("href", "https://fixture.test/screenshot.png");
  await userEvent.click(
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it.each([
  "http://fixture.test/a.png",
  "javascript:alert(1)",
  "data:image/png;base64,AA",
])("refuses %s", (src) => {
  const onClose = vi.fn();
  render(<ImageViewer src={src} onClose={onClose} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledOnce();
});
