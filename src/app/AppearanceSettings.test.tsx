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

it("retry saves the System choice even when its current palette is light", async () => {
  const appearance = createAppearance();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("denied");
    });
  act(() => appearance.setMode("system"));
  render(
    <ToastProvider>
      <AppearanceSettings appearance={appearance} />
    </ToastProvider>,
  );
  expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry saving appearance" }),
  );
  expect(write).toHaveBeenLastCalledWith("buzz-appearance.v1", "system");
  expect(localStorage.getItem("buzz-appearance.v1")).toBe("system");
  appearance.dispose();
});
