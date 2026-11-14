// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { AgentResponsePreview } from "./AgentResponsePreview";

stubAvatarBrowserApis();
afterEach(cleanup);

it("names every agent in its byline, and keeps the one-agent hint to one agent", () => {
  const view = (names: string[]) => (
    <AgentResponsePreview
      name={names[0] ?? ""}
      bylineHint={<span>Remote</span>}
      participants={names.map((name) => ({ id: name, name }))}
    >
      Working
    </AgentResponsePreview>
  );
  const { rerender } = render(view(["Martha"]));
  expect(screen.getByText("Martha", { exact: true })).toBeVisible();
  expect(screen.getByText("Remote")).toBeVisible();
  rerender(view(["Martha", "Leona"]));
  expect(screen.getByText("Martha and Leona", { exact: true })).toBeVisible();
  expect(screen.queryByText("Remote")).toBeNull();
  rerender(view(["Gordon", "Henry", "Darcy"]));
  expect(
    screen.getByText("Gordon, Henry, and Darcy", { exact: true }),
  ).toBeVisible();
  rerender(view(["Gordon", "Henry", "Darcy", "Catherine", "Oliver"]));
  expect(
    screen.getByText("Gordon, Henry, and 3 others", { exact: true }),
  ).toBeVisible();
});
