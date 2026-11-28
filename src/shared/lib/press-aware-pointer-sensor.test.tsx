// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  DndContext,
  useDndContext,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PressAwarePointerSensor } from "./press-aware-pointer-sensor";

afterEach(() => vi.unstubAllGlobals());

const options = { activationConstraint: { distance: 6 } };

function Row({ onClick }: { onClick: () => void }) {
  const drag = useDraggable({ id: "row" });
  const { active } = useDndContext();
  return (
    <>
      <button
        type="button"
        ref={drag.setNodeRef}
        {...drag.listeners}
        {...drag.attributes}
        onClick={onClick}
      >
        Row
      </button>
      <p>{active ? "dragging" : "idle"}</p>
    </>
  );
}

function Sidebar({ onClick }: { onClick: () => void }) {
  const sensors = useSensors(useSensor(PressAwarePointerSensor, options));
  return (
    <DndContext sensors={sensors}>
      <Row onClick={onClick} />
    </DndContext>
  );
}

function press(target: Element, buttons: number) {
  const down = new MouseEvent("pointerdown", {
    bubbles: true,
    button: 0,
    buttons,
    clientX: 10,
    clientY: 10,
  });
  Object.defineProperty(down, "isPrimary", { value: true });
  fireEvent(target, down);
}

it("lets a click through after a press with no button held, and still drags on a real press", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const onClick = vi.fn();
  render(<Sidebar onClick={onClick} />);
  const row = screen.getByRole("button", { name: "Row" });

  // macOS tap-to-click: no button held, and the release arrives late or never.
  press(row, 0);
  fireEvent.pointerMove(document, { clientX: 80, clientY: 80 });
  fireEvent.click(row);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(screen.getByText("idle")).toBeInTheDocument();

  press(row, 1);
  fireEvent.pointerMove(document, { clientX: 80, clientY: 80 });
  await waitFor(() => expect(screen.getByText("dragging")).toBeInTheDocument());
  fireEvent.pointerUp(document);
});
