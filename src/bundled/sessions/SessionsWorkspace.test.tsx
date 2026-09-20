// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionsWorkspace } from "./SessionsWorkspace";

afterEach(cleanup);

it("shows unread state beside a saved session", () => {
  render(
    <SessionsWorkspace
      sessions={[
        {
          id: "session",
          title: "Plan the release",
          badge: <span data-testid="session-unread">Unread</span>,
        },
      ]}
      selected=""
      onSelect={vi.fn()}
      onNew={vi.fn()}
    >
      <div>Session content</div>
    </SessionsWorkspace>,
  );
  expect(screen.getByTestId("session-unread")).toBeVisible();
});
