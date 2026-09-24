// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { BuilderLabSettings } from "./BuilderLabSettings";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
});

afterEach(cleanup);

it("checks once when the tab becomes active and shows the logged-in result", async () => {
  vi.mocked(invoke).mockResolvedValue({ status: "available" });
  const { rerender } = render(<BuilderLabSettings active={false} />);
  rerender(<BuilderLabSettings active />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking BuilderLab login",
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "You are logged into BuilderLab",
    ),
  );
  expect(invoke).toHaveBeenCalledOnce();
  rerender(<BuilderLabSettings active={false} />);
  rerender(<BuilderLabSettings active />);
  expect(invoke).toHaveBeenCalledOnce();
});

it("shows the CLI login guidance for a missing credential", async () => {
  vi.mocked(invoke).mockResolvedValue({ status: "loggedOut" });
  render(<BuilderLabSettings />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Login to BuilderLab via the bl cli",
    ),
  );
  expect(screen.getByText(/bl auth login/)).toBeInTheDocument();
});

it("does not claim login when native configuration fails", async () => {
  vi.mocked(invoke).mockResolvedValue({
    status: "error",
    message: "BUILDERLAB_URL must be a credential-free HTTPS URL",
  });
  render(<BuilderLabSettings />);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "BuilderLab connection unavailable",
    ),
  );
  expect(screen.queryByText("You are logged into BuilderLab")).toBeNull();
});
