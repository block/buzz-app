// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { VoicePreview } from "./VoicePreview";
import { previewVoice } from "./voice-preview";
import type { Spawn } from "./rpc";

vi.mock("./voice-preview", () => ({ previewVoice: vi.fn() }));
const spawn: Spawn = async () => {
  throw new Error("Unexpected process");
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("previews the unsaved choice, stops immediately, and ignores a late failure", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(previewVoice).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const user = userEvent.setup();
  render(<VoicePreview spawn={spawn} voice="maple" disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  expect(previewVoice).toHaveBeenCalledWith(
    spawn,
    "maple",
    expect.any(AbortSignal),
  );
  const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
  await user.click(screen.getByRole("button", { name: "Stop preview" }));
  expect(signal?.aborted).toBe(true);
  reject(new Error("Late error"));
  expect(
    await screen.findByRole("button", { name: "Preview voice" }),
  ).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("ends a preview when its keyed voice changes or settings closes", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(
    <VoicePreview key="cove" spawn={spawn} voice="cove" disabled={false} />,
  );
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  const first = vi.mocked(previewVoice).mock.calls[0]?.[2];
  view.rerender(
    <VoicePreview key="maple" spawn={spawn} voice="maple" disabled={false} />,
  );
  expect(first?.aborted).toBe(true);
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  const second = vi.mocked(previewVoice).mock.calls[1]?.[2];
  view.unmount();
  expect(second?.aborted).toBe(true);
});

it("shows errors and lets the user retry the default voice", async () => {
  vi.mocked(previewVoice)
    .mockRejectedValueOnce(new Error("Sign in to Codex."))
    .mockResolvedValueOnce();
  const user = userEvent.setup();
  render(<VoicePreview spawn={spawn} voice="" disabled={false} />);
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in to Codex.",
  );
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(previewVoice).toHaveBeenLastCalledWith(
    spawn,
    "",
    expect.any(AbortSignal),
  );
});
