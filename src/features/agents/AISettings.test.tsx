// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AISettings, Checking, UsesLine } from "./AISettings";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("holds back Checking a second, so a quick check doesn't flash it", () => {
  vi.useFakeTimers();
  render(<Checking />);
  expect(screen.queryByText("Checking this computer…")).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("Checking this computer…")).toBeInTheDocument();
});

it("describes the AI settings choice by what Automatic uses, and announces it", () => {
  render(
    <AISettings
      automatic
      summary={
        <UsesLine
          icon={undefined}
          title="Goose"
          candidate={{ label: "Model B", effort: "high" }}
        />
      }
      onChange={() => {}}
    >
      <p>Manual rows</p>
    </AISettings>,
  );
  const trigger = screen.getByRole("combobox", { name: "AI settings" });
  const description = document.getElementById(
    trigger.getAttribute("aria-describedby") ?? "",
  );
  expect(description).toHaveTextContent("Uses Goose: Model B · High");
  expect(screen.getByRole("status")).toHaveTextContent("Model B · High");
  // The full value is there on hover when the chip cuts it short.
  expect(screen.getByTitle("Model B · High")).toBeInTheDocument();
});
