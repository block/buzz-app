// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, expect, test, vi } from "vitest";
import { AppDock } from "./AppDock";

afterEach(cleanup);

test("Escape dismisses the sidebar from its own controls, not from the list it portals", () => {
  const onDismiss = vi.fn();
  const slot = document.body.appendChild(document.createElement("div"));
  render(
    <AppDock
      search={null}
      community={null}
      profile={null}
      settings={null}
      showPrimaryNavigation={false}
      pages={[]}
      selected=""
      onSelect={() => {}}
      onDismiss={onDismiss}
    >
      <button type="button">Sidebar row</button>
      {createPortal(<button type="button">List row</button>, slot)}
    </AppDock>,
  );
  // React delivers a portal's events to the tree that rendered it.
  fireEvent.keyDown(screen.getByRole("button", { name: "List row" }), {
    key: "Escape",
  });
  expect(onDismiss).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("button", { name: "Sidebar row" }), {
    key: "Escape",
  });
  expect(onDismiss).toHaveBeenCalledOnce();
  slot.remove();
});
