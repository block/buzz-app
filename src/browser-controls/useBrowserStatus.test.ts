// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useBrowserStatus } from "./useBrowserStatus";

const sdk = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: sdk.invoke }));

afterEach(() => {
  sdk.invoke.mockReset();
});

it("applies the first poll result", async () => {
  sdk.invoke.mockResolvedValue({
    url: "https://example.com",
    title: "Example",
    loading: false,
    error: null,
  });
  const { result, unmount } = renderHook(() => useBrowserStatus(50_000));
  await waitFor(() => expect(result.current.url).toBe("https://example.com"));
  unmount();
});

it("never overlaps polls: the next tick waits for the in-flight call", async () => {
  let resolveFirst!: (value: unknown) => void;
  sdk.invoke.mockImplementationOnce(
    () => new Promise((resolve) => (resolveFirst = resolve)),
  );
  // A large interval means the schedule set in the first call's `finally`
  // cannot itself fire during this test, isolating the assertion to the
  // one poll that was in flight when the hook mounted.
  const { result, unmount } = renderHook(() => useBrowserStatus(10_000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sdk.invoke).toHaveBeenCalledTimes(1);
  resolveFirst({
    url: "https://first.example.com",
    title: "",
    loading: false,
    error: null,
  });
  await waitFor(() =>
    expect(result.current.url).toBe("https://first.example.com"),
  );
  expect(sdk.invoke).toHaveBeenCalledTimes(1);
  unmount();
});

it("ignores a late result that resolves after unmount", async () => {
  let resolveFirst!: (value: unknown) => void;
  sdk.invoke.mockImplementationOnce(
    () => new Promise((resolve) => (resolveFirst = resolve)),
  );
  const { result, unmount } = renderHook(() => useBrowserStatus(50_000));
  unmount();
  resolveFirst({
    url: "https://should-not-apply.example.com",
    title: "",
    loading: false,
    error: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(result.current.url).toBe("");
});
