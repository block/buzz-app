// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { VoicePreview } from "./VoicePreview";
import { previewVoice, preloadPreview } from "./voice-preview";
import type { PreviewHost } from "./voice-preview";

vi.mock("./voice-preview", () => ({
  previewVoice: vi.fn(),
  preloadPreview: vi.fn(async () => new Uint8Array()),
}));
const voiceName = () =>
  screen.queryByRole("radio", { name: "Maple", checked: true })
    ? "Maple"
    : screen.queryByRole("radio", { name: "Cove", checked: true })
      ? "Cove"
      : "Codex default";
const host: PreviewHost = { request: vi.fn(), requestBytes: vi.fn() };
const previews = {
  cove: "https://persistent.oaistatic.com/voice/previews/cove.test.m4a",
  maple: "https://persistent.oaistatic.com/voice/previews/maple.test.m4a",
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(previewVoice).mockReset();
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
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="maple"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  expect(previewVoice).toHaveBeenCalledWith(
    host,
    previews.maple,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(signal?.aborted).toBe(true);
  reject(new Error("Late error"));
  expect(await screen.findByRole("button", { name: "Voice" })).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("ends a preview when its keyed voice changes or settings closes", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(
    <VoicePreview
      key="cove"
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="cove"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  const first = vi.mocked(previewVoice).mock.calls[0]?.[2];
  view.rerender(
    <VoicePreview
      key="maple"
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="maple"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(first?.aborted).toBe(true);
  if (!screen.queryByRole("dialog"))
    await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  const second = vi.mocked(previewVoice).mock.calls[1]?.[2];
  view.unmount();
  expect(second?.aborted).toBe(true);
});

it("shows errors and lets the user retry the default voice", async () => {
  vi.mocked(previewVoice)
    .mockRejectedValueOnce(new Error("Sign in to Codex."))
    .mockResolvedValueOnce();
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice=""
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  if (!screen.queryByRole("dialog"))
    await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in to Codex.",
  );
  if (!screen.queryByRole("dialog"))
    await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(previewVoice).toHaveBeenLastCalledWith(
    host,
    "",
    expect.any(AbortSignal),
    expect.any(Function),
  );
});

it("selects and previews rows, replaces playback and stops on dismissal", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="cove"
      defaultVoice="cove"
      disabled={false}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  expect(screen.getByRole("radio", { name: "Cove" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  const first = vi.mocked(previewVoice).mock.calls[0]?.[2];
  expect(onChange).toHaveBeenCalledWith("maple");
  expect(screen.getByRole("dialog")).toBeVisible();
  await user.click(screen.getByRole("radio", { name: "Cove" }));
  expect(first?.aborted).toBe(true);
  const second = vi.mocked(previewVoice).mock.calls[1]?.[2];
  await user.keyboard("{Escape}");
  expect(second?.aborted).toBe(true);
  expect(screen.getByRole("button", { name: "Voice" })).toBeVisible();
});

it("chooses and previews a row without closing the picker", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice=""
      defaultVoice="cove"
      disabled={false}
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("button", { name: "Voice" })).toHaveTextContent(
    "Cove · Default",
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  expect(onChange).toHaveBeenCalledWith("maple");
  expect(previewVoice).toHaveBeenCalledWith(
    host,
    previews.maple,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("ignores stale audio callbacks after another selection", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice="cove"
      voices={["cove", "maple"]}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: "Cove" }));
  const first = vi.mocked(previewVoice).mock.calls[0];
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  act(() => first?.[3]?.());
  expect(first?.[2].aborted).toBe(true);
  expect(vi.mocked(previewVoice).mock.calls[1]?.[2].aborted).toBe(false);
});

it("preloads the selected recording, then the other choices when the picker opens", async () => {
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice=""
      defaultVoice="cove"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(preloadPreview).toHaveBeenCalledWith(host, previews.cove),
  );
  expect(preloadPreview).not.toHaveBeenCalledWith(host, previews.maple);
  await user.click(screen.getByRole("button", { name: "Voice" }));
  expect(preloadPreview).toHaveBeenCalledWith(host, previews.maple);
});

it("keeps playback alive when loading changes to playing", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice="cove"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  if (!screen.queryByRole("dialog"))
    await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: voiceName() }));
  const call = vi.mocked(previewVoice).mock.calls[0];
  act(() => call?.[3]?.());
  expect(call?.[2].aborted).toBe(false);
  view.unmount();
  expect(call?.[2].aborted).toBe(true);
});
it("keeps arrow navigation and activation of the selected row open", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <VoicePreview
      host={host}
      voices={["cove", "maple"]}
      previews={previews}
      voice=""
      defaultVoice="cove"
      disabled={false}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  screen.getByRole("radio", { name: "Codex default (Cove)" }).focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("dialog", { name: "Choose voice" })).toBeVisible();
  expect(onChange).toHaveBeenCalledWith("cove");
  await user.click(screen.getByRole("radio", { name: "Codex default (Cove)" }));
  expect(screen.getByRole("dialog", { name: "Choose voice" })).toBeVisible();
});

it("stops a pending preview when retained settings become hidden", async () => {
  let visible = true;
  const previous = HTMLElement.prototype.checkVisibility;
  HTMLElement.prototype.checkVisibility = () => visible;
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(
    <div data-testid="retained">
      <VoicePreview
        host={host}
        voices={["cove", "maple"]}
        previews={previews}
        voice="maple"
        disabled={false}
        onChange={vi.fn()}
      />
    </div>,
  );
  try {
    if (!screen.queryByRole("dialog"))
      await user.click(screen.getByRole("button", { name: "Voice" }));
    await user.click(screen.getByRole("radio", { name: voiceName() }));
    const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
    visible = false;
    view.getByTestId("retained").hidden = true;
    await waitFor(() => expect(signal?.aborted).toBe(true));
  } finally {
    HTMLElement.prototype.checkVisibility = previous;
  }
});

it("stops hidden retained previews without checkVisibility", async () => {
  const previous = HTMLElement.prototype.checkVisibility;
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const user = userEvent.setup();
  const view = render(
    <div data-testid="older">
      <VoicePreview
        host={host}
        voices={["cove", "maple"]}
        previews={previews}
        voice="maple"
        disabled={false}
        onChange={vi.fn()}
      />
    </div>,
  );
  try {
    if (!screen.queryByRole("dialog"))
      await user.click(screen.getByRole("button", { name: "Voice" }));
    await user.click(screen.getByRole("radio", { name: voiceName() }));
    const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
    view.getByTestId("older").hidden = true;
    await waitFor(() => expect(signal?.aborted).toBe(true));
  } finally {
    HTMLElement.prototype.checkVisibility = previous;
  }
});

it("filters supported voices by locale without changing the saved voice", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <VoicePreview
      voice="vale"
      voices={["cove", "vale", "neer", "new"]}
      accents={{
        cove: "American English",
        vale: "British English",
        neer: "Hindi",
        unsupported: "French",
      }}
      disabled={false}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Voice" });
  expect(trigger).toHaveAttribute("data-variant", "outline");
  await user.click(trigger);
  const locale = screen.getByRole("combobox", { name: "Language and region" });
  expect(locale).toHaveTextContent("British English");
  expect(screen.getByRole("radio", { name: "Vale" })).toBeChecked();
  expect(screen.queryByRole("radio", { name: "Cove" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus(),
  );
  locale.focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.queryByRole("option", { name: "French" })).toBeNull();
  await user.click(await screen.findByRole("option", { name: "Hindi" }));
  expect(screen.getByRole("radio", { name: "Neer" })).toBeEnabled();
  expect(screen.queryByRole("radio", { name: "Vale" })).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  await waitFor(() => expect(locale).toHaveFocus());
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("option", { name: "Other voices" }));
  expect(screen.getByRole("radio", { name: "New" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  expect(locale).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Language and region" }),
  ).toHaveTextContent("British English");
});

it("reports a failed save without previewing it and allows a retry", async () => {
  const onChange = vi
    .fn()
    .mockRejectedValueOnce(new Error("Could not save voice"))
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice="cove"
      voices={["cove", "maple"]}
      disabled={false}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save voice",
  );
  expect(previewVoice).not.toHaveBeenCalled();
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  expect(previewVoice).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: /preview/i })).toBeNull();
});

it("does not start audio when a save finishes after closing the picker", async () => {
  let finish!: () => void;
  const onChange = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice="cove"
      voices={["cove", "maple"]}
      disabled={false}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  await user.click(screen.getByRole("radio", { name: "Maple" }));
  await user.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => finish());
  expect(previewVoice).not.toHaveBeenCalled();
});
