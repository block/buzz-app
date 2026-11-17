// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { VoicePreview } from "./VoicePreview";
import { previewVoice, preloadPreview } from "./voice-preview";
import type { PreviewHost } from "./voice-preview";

vi.mock("./voice-preview", () => ({
  previewVoice: vi.fn(),
  preloadPreview: vi.fn(async () => new Uint8Array()),
}));
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
      previews={previews}
      voice="maple"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  expect(previewVoice).toHaveBeenCalledWith(
    host,
    previews.maple,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
  await user.click(
    screen.getByRole("button", { name: "Cancel loading preview" }),
  );
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
    <VoicePreview
      key="cove"
      host={host}
      previews={previews}
      voice="cove"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  const first = vi.mocked(previewVoice).mock.calls[0]?.[2];
  view.rerender(
    <VoicePreview
      key="maple"
      host={host}
      previews={previews}
      voice="maple"
      disabled={false}
      onChange={vi.fn()}
    />,
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
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice=""
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in to Codex.",
  );
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
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

it("previews dialog rows independently from selection and stops on dismissal", async () => {
  vi.mocked(previewVoice).mockImplementation(() => new Promise(() => {}));
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice="cove"
      voices={["cove", "maple"]}
      defaultVoice="cove"
      disabled={false}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Voice" }));
  expect(screen.getByRole("radio", { name: "Cove" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Preview Maple" }));
  const first = vi.mocked(previewVoice).mock.calls[0]?.[2];
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: "Cove" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Preview Cove" }));
  expect(first?.aborted).toBe(true);
  const second = vi.mocked(previewVoice).mock.calls[1]?.[2];
  await user.keyboard("{Escape}");
  expect(second?.aborted).toBe(true);
  expect(screen.getByRole("button", { name: "Preview voice" })).toBeVisible();
});

it("chooses a row without starting a preview", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice=""
      voices={["cove", "maple"]}
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
  expect(previewVoice).not.toHaveBeenCalled();
});

it("keeps loading cancellable until the first audio and ignores stale audio callbacks", async () => {
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
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  const loading = screen.getByRole("button", {
    name: "Cancel loading preview",
  });
  expect(loading).toBeEnabled();
  expect(loading).toHaveAttribute("aria-busy", "true");
  const stale = vi.mocked(previewVoice).mock.calls[0]?.[3];
  await user.click(loading);
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  act(() => stale?.());
  expect(
    screen.getByRole("button", { name: "Cancel loading preview" }),
  ).toHaveAttribute("aria-busy", "true");
  act(() => vi.mocked(previewVoice).mock.calls[1]?.[3]?.());
  expect(
    screen.getByRole("button", { name: "Stop preview" }),
  ).not.toHaveAttribute("aria-busy", "true");
  expect(vi.mocked(previewVoice).mock.calls[1]?.[2].aborted).toBe(false);
});

it("preloads the selected recording, then the other choices when the picker opens", async () => {
  const user = userEvent.setup();
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice=""
      defaultVoice="cove"
      voices={["cove", "maple"]}
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
      previews={previews}
      voice="cove"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Preview voice" }));
  const call = vi.mocked(previewVoice).mock.calls[0];
  act(() => call?.[3]?.());
  expect(call?.[2].aborted).toBe(false);
  view.unmount();
  expect(call?.[2].aborted).toBe(true);
});
it("keeps arrow navigation open and dismisses activation of the selected row", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <VoicePreview
      host={host}
      previews={previews}
      voice=""
      voices={["cove", "maple"]}
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
  expect(
    screen.queryByRole("dialog", { name: "Choose voice" }),
  ).not.toBeInTheDocument();
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
        previews={previews}
        voice="maple"
        disabled={false}
        onChange={vi.fn()}
      />
    </div>,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Preview voice" }));
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
        previews={previews}
        voice="maple"
        disabled={false}
        onChange={vi.fn()}
      />
    </div>,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Preview voice" }));
    const signal = vi.mocked(previewVoice).mock.calls[0]?.[2];
    view.getByTestId("older").hidden = true;
    await waitFor(() => expect(signal?.aborted).toBe(true));
  } finally {
    HTMLElement.prototype.checkVisibility = previous;
  }
});

it("groups supported choices by discovered accent and leaves unknown choices available", async () => {
  const user = userEvent.setup();
  render(
    <VoicePreview
      voice=""
      voices={["cove", "vale", "neer", "new"]}
      accents={{
        cove: "American English",
        vale: "British English",
        neer: "Hindi",
        unsupported: "French",
      }}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Voice" });
  expect(trigger).toHaveAttribute("data-variant", "outline");
  await user.click(trigger);
  expect(
    within(screen.getByRole("group", { name: "British English" })).getByRole(
      "radio",
      { name: "Vale" },
    ),
  ).toBeEnabled();
  expect(
    within(screen.getByRole("group", { name: "Hindi" })).getByRole("radio", {
      name: "Neer",
    }),
  ).toBeEnabled();
  expect(
    within(screen.getByRole("group", { name: "Other voices" })).getByRole(
      "radio",
      { name: "New" },
    ),
  ).toBeEnabled();
  expect(screen.queryByRole("group", { name: "French" })).toBeNull();
});
