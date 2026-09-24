// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AgentCard } from "./AgentCard";
afterEach(cleanup);
it("keeps the exact identity label and row heading in the final card shell", () => {
  render(
    <AgentCard name="Solo" identities={[]} layout="row" headingLevel={4} />,
  );
  expect(screen.getByRole("article", { name: "Agent Solo" })).toHaveClass(
    "agent-inventory-row",
  );
  expect(screen.getByRole("heading", { level: 4, name: "Solo" })).toBeVisible();
});
