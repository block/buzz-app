// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ShareModelPicker } from "./ShareModelPicker";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const catalog = {
  gpuName: "Fixture GPU",
  vramDisplay: "32 GB",
  recommended: "fixture/model:Q4",
  entries: [
    {
      model: "fixture/model:Q4",
      name: "Fixture model",
      size: "6GB",
      installed: false,
      curated: true,
      fit: "comfortable",
    },
  ],
};
function Fixture() {
  const [model, setModel] = useState("");
  return (
    <ShareModelPicker model={model} onChange={setModel} disabled={false} />
  );
}
it("selects the SDK-backed recommendation and discloses the download before sharing", async () => {
  invoke.mockResolvedValue(catalog);
  render(<Fixture />);
  await screen.findByText("Fixture GPU · 32 GB AI memory");
  await screen.findByText(
    "Fixture model — automatically selected for this device.",
  );
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  expect(screen.getByRole("combobox")).toHaveTextContent("recommended");
  expect(
    screen.getByText("Downloads 6GB when you share. Memory fit: comfortable."),
  ).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("mesh_compute_catalog");
});
it("keeps manual selection usable on catalog failure and retries the catalog", async () => {
  invoke
    .mockRejectedValueOnce("Catalog unavailable")
    .mockResolvedValue(catalog);
  render(<Fixture />);
  await screen.findByText("Catalog unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  fireEvent.change(
    screen.getByLabelText("Model reference or local GGUF path"),
    { target: { value: "/local.gguf" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry model catalog" }));
  await screen.findByText("Fixture GPU · 32 GB AI memory");
  expect(
    screen.getByLabelText("Model reference or local GGUF path"),
  ).toHaveValue("/local.gguf");
});
it("ignores a catalog response after unmount", async () => {
  let resolve!: (value: typeof catalog) => void;
  const gate = new Promise<typeof catalog>((done) => {
    resolve = done;
  });
  invoke.mockReturnValue(gate);
  const onChange = vi.fn();
  const view = render(
    <ShareModelPicker model="" onChange={onChange} disabled={false} />,
  );
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  view.unmount();
  resolve(catalog);
  await gate;
  expect(onChange).not.toHaveBeenCalled();
});

it("bounds loading and ignores a late response after timeout", async () => {
  vi.useFakeTimers();
  let release!: (value: typeof catalog) => void;
  invoke.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  try {
    render(<Fixture />);
    expect(screen.getByText("Loading model choices…")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("took too long");
    await act(async () => {
      release(catalog);
    });
    expect(
      screen.queryByText("Fixture GPU · 32 GB AI memory"),
    ).not.toBeInTheDocument();
    invoke.mockResolvedValue(catalog);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Retry model catalog" }),
      );
    });
    expect(
      screen.getByText(
        "Fixture model — automatically selected for this device.",
      ),
    ).toBeInTheDocument();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
