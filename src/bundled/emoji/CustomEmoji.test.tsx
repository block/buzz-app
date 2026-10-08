// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { copyEmoji } from "./copy-emoji";
import { CustomEmoji } from "./CustomEmoji";

afterEach(cleanup);
const emoji = { shortcode: "party", url: "https://emoji.test/party.png" };
const box = (image: HTMLElement) =>
  ["class", "width", "height", "alt", "title", "data-copy-emoji"].map((name) =>
    image.getAttribute(name),
  );

it("keeps the same box when media is unavailable or fails, never text", () => {
  const view = render(
    <CustomEmoji emoji={emoji} media={() => "https://media.test/party.png"} />,
  );
  const loaded = screen.getByRole("img", { name: ":party:" });
  expect(loaded).toHaveAttribute("src", "https://media.test/party.png");
  expect(loaded).not.toHaveAttribute("data-unavailable");
  const expected = box(loaded);
  expect(expected).toEqual([
    expect.any(String),
    "22",
    "22",
    ":party:",
    ":party:",
    ":party:",
  ]);

  fireEvent.error(loaded);
  const failed = screen.getByRole("img", { name: ":party:" });
  expect(failed).toHaveAttribute("data-unavailable");
  expect(failed.getAttribute("src")).toMatch(/^data:image\/gif/);
  expect(box(failed)).toEqual(expected);
  expect(screen.queryByText(":party:")).not.toBeInTheDocument();

  // Another source (media policy changed) is tried again.
  view.rerender(
    <CustomEmoji emoji={emoji} media={() => "https://media.test/next.png"} />,
  );
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://media.test/next.png",
  );

  view.rerender(<CustomEmoji emoji={emoji} media={() => undefined} />);
  const unavailable = screen.getByRole("img", { name: ":party:" });
  expect(unavailable).toHaveAttribute("data-unavailable");
  expect(box(unavailable)).toEqual(expected);
});

it("copies a placeholder as its shortcode", () => {
  render(
    <p>
      Hi <CustomEmoji emoji={emoji} media={() => undefined} /> there
    </p>,
  );
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(screen.getByText(/Hi/));
  selection?.removeAllRanges();
  selection?.addRange(range);
  const setData = vi.fn();
  const preventDefault = vi.fn();
  copyEmoji({
    defaultPrevented: false,
    clipboardData: { setData },
    composedPath: () => [],
    preventDefault,
  } as unknown as ClipboardEvent);
  expect(setData).toHaveBeenCalledWith("text/plain", "Hi :party: there");
  expect(preventDefault).toHaveBeenCalled();
});
