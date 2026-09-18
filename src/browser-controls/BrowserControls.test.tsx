// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserControls } from "./BrowserControls";

const sdk = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: sdk.invoke }));

afterEach(() => {
  cleanup();
  sdk.invoke.mockReset();
});

function statusResult(
  patch: Partial<{
    url: string;
    title: string;
    loading: boolean;
    error: string | null;
  }>,
) {
  return { url: "", title: "", loading: false, error: null, ...patch };
}

it("shows the current address once status resolves", async () => {
  sdk.invoke.mockImplementation((command: string) =>
    command === "browser_status"
      ? Promise.resolve(statusResult({ url: "https://example.com" }))
      : Promise.resolve(undefined),
  );
  render(<BrowserControls />);
  await waitFor(() =>
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com"),
  );
});

it("submits an edited address via browser_navigate", async () => {
  sdk.invoke.mockImplementation((command: string) =>
    command === "browser_status"
      ? Promise.resolve(statusResult({ url: "https://example.com" }))
      : Promise.resolve(undefined),
  );
  const user = userEvent.setup();
  render(<BrowserControls />);
  const input = await screen.findByLabelText("Address");
  await waitFor(() => expect(input).toHaveValue("https://example.com"));
  await user.clear(input);
  await user.type(input, "https://other.example.com{Enter}");
  await waitFor(() =>
    expect(sdk.invoke).toHaveBeenCalledWith("browser_navigate", {
      url: "https://other.example.com",
    }),
  );
});

it("routes back/forward/reload to browser_action", async () => {
  sdk.invoke.mockImplementation((command: string) =>
    command === "browser_status"
      ? Promise.resolve(statusResult({}))
      : Promise.resolve(undefined),
  );
  const user = userEvent.setup();
  render(<BrowserControls />);
  await user.click(screen.getByLabelText("Back"));
  await user.click(screen.getByLabelText("Forward"));
  await user.click(screen.getByLabelText("Reload"));
  expect(sdk.invoke).toHaveBeenCalledWith("browser_action", {
    action: "back",
  });
  expect(sdk.invoke).toHaveBeenCalledWith("browser_action", {
    action: "forward",
  });
  expect(sdk.invoke).toHaveBeenCalledWith("browser_action", {
    action: "reload",
  });
});

it("shows a rejected browser_navigate immediately, without an unhandled rejection", async () => {
  sdk.invoke.mockImplementation((command: string) =>
    command === "browser_status"
      ? Promise.resolve(statusResult({ url: "file:///etc/passwd" }))
      : command === "browser_navigate"
        ? Promise.reject(new Error("Only http and https URLs are supported"))
        : Promise.resolve(undefined),
  );
  const user = userEvent.setup();
  render(<BrowserControls />);
  const input = await screen.findByLabelText("Address");
  await waitFor(() => expect(input).toHaveValue("file:///etc/passwd"));
  await user.clear(input);
  await user.type(input, "file:///etc/passwd{Enter}");
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Only http and https URLs are supported");
});

it("renders a status error as escaped text, not markup", async () => {
  sdk.invoke.mockImplementation((command: string) =>
    command === "browser_status"
      ? Promise.resolve(statusResult({ error: "<img src=x onerror=alert(1)>" }))
      : Promise.resolve(undefined),
  );
  render(<BrowserControls />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("<img src=x onerror=alert(1)>");
  expect(alert.querySelector("img")).toBeNull();
});
