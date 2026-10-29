// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSearchHighlight } from "./use-search-highlight";

// jsdom lacks scrollIntoView; typed text reveals its highlighted row.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function Picker(props: {
  query: string;
  keys: readonly string[];
  pending: boolean;
  open?: boolean;
  onChoose: (key: string) => void;
}) {
  const highlight = useSearchHighlight(props);
  return (
    <>
      <input aria-label="Search" onKeyDown={highlight.keyDown} />
      <div data-testid="rows" {...highlight.listProps}>
        {props.keys.map((key) => (
          <div key={key} {...highlight.rowProps(key)}>
            {key}
          </div>
        ))}
      </div>
    </>
  );
}

it("chooses the first row once results stop pending after Enter", () => {
  const onChoose = vi.fn();
  const props = { query: "de", pending: true, onChoose };
  const { rerender } = render(<Picker {...props} keys={[]} />);
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })).toBe(
    false,
  );
  // A row that lands while a better one may still arrive is not chosen.
  rerender(<Picker {...props} keys={["message"]} />);
  expect(onChoose).not.toHaveBeenCalled();
  rerender(<Picker {...props} keys={["design", "message"]} pending={false} />);
  expect(onChoose).toHaveBeenCalledExactlyOnceWith("design");
  rerender(<Picker {...props} keys={["message"]} pending={false} />);
  expect(onChoose).toHaveBeenCalledOnce();
});

it("drops a waiting Enter once Enter chooses a row", () => {
  const onChoose = vi.fn();
  const props = { query: "de", onChoose };
  const { rerender } = render(<Picker {...props} pending keys={[]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  rerender(<Picker {...props} pending keys={["more"]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(onChoose).toHaveBeenCalledExactlyOnceWith("more");
  rerender(<Picker {...props} pending={false} keys={["design", "more"]} />);
  expect(onChoose).toHaveBeenCalledOnce();
});

it("drops a waiting Enter when the picker closes", () => {
  const onChoose = vi.fn();
  const props = { query: "de", onChoose };
  const { rerender } = render(<Picker {...props} pending keys={[]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  rerender(<Picker {...props} pending open={false} keys={[]} />);
  rerender(
    <Picker {...props} pending={false} open={false} keys={["design"]} />,
  );
  expect(onChoose).not.toHaveBeenCalled();
});

it.each([
  ["an edit", () => {}, "des"],
  [
    "an arrow key",
    () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" }),
    "de",
  ],
  [
    "Escape",
    () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" }),
    "de",
  ],
  [
    "a pointer move",
    () => {
      const rows = screen.getByTestId("rows");
      fireEvent.pointerMove(rows, { clientX: 1, clientY: 1 });
      fireEvent.pointerMove(rows, { clientX: 2, clientY: 1 });
    },
    "de",
  ],
] as const)("lets %s cancel a waiting Enter", (_, cancel, query) => {
  const onChoose = vi.fn();
  const props = { pending: true, onChoose };
  const { rerender } = render(<Picker {...props} query="de" keys={[]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  cancel();
  rerender(<Picker {...props} query={query} keys={[]} />);
  rerender(<Picker {...props} query={query} keys={["design"]} />);
  // Returning to the text does not revive it either.
  rerender(<Picker {...props} query="de" keys={["design"]} />);
  expect(onChoose).not.toHaveBeenCalled();
});

it("drops a waiting Enter when the results settle empty, and ignores Enter with nothing pending", () => {
  const onChoose = vi.fn();
  const props = { query: "de", onChoose };
  const { rerender } = render(<Picker {...props} pending keys={[]} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  rerender(<Picker {...props} pending={false} keys={[]} />);
  rerender(<Picker {...props} pending={false} keys={["design"]} />);
  expect(onChoose).not.toHaveBeenCalled();
  rerender(<Picker {...props} pending={false} keys={[]} />);
  expect(fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })).toBe(
    true,
  );
});
