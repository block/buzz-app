// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { createAppearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("hidden settings do not portal errors; returning retains both save recovery actions", async () => {
  const appearance = createAppearance();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  act(() => {
    appearance.setMode("dark");
    appearance.setFontScale(1.2);
  });
  const content = (active: boolean) => (
    <ToastProvider>
      <AppearanceSettings appearance={appearance} active={active} />
    </ToastProvider>
  );
  const view = render(content(false));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(content(true));
  expect(screen.getAllByRole("dialog")).toHaveLength(2);
  view.rerender(content(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(appearance.snapshot().error).not.toBeNull();
  view.rerender(content(true));
  write.mockRestore();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry saving appearance" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Retry saving text size" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(localStorage.getItem("buzz-appearance.v1")).toBe("dark");
  expect(localStorage.getItem("buzz-font-scale.v1")).toBe("1.2");
  appearance.dispose();
});
