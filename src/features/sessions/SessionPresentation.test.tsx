// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { NewSessionView, SessionHeading } from "./SessionPresentation";

afterEach(cleanup);

it("keeps management actions after archival without exposing active-only actions", () => {
  const props = {
    channel: { name: "Session", private: true as const },
    actions: <button type="button">Manage</button>,
    children: <button type="button">Share</button>,
  };
  const view = render(<SessionHeading {...props} />);
  expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  view.rerender(
    <SessionHeading
      {...props}
      channel={{ ...props.channel, archived: true }}
    />,
  );
  expect(screen.getByText("Archived")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Share" }),
  ).not.toBeInTheDocument();
});

it("keeps the existing no-actions heading empty", () => {
  const { container } = render(
    <SessionHeading channel={{ name: "Session" }} />,
  );
  expect(container.querySelector(".panel-header-actions")).toBeNull();
});

it("rejects files dropped outside a new conversation's composer", () => {
  render(
    <NewSessionView personal>
      <p>Prompt</p>
    </NewSessionView>,
  );
  for (const kind of ["dragOver", "drop"] as const) {
    const target = screen.getByText("Prompt");
    const dataTransfer = { types: ["Files"], files: [], dropEffect: "copy" };
    const event = createEvent[kind](target, { dataTransfer, bubbles: true });
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("none");
  }
});
