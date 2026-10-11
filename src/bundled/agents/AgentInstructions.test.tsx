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
import { invoke } from "@tauri-apps/api/core";
import { createRef } from "react";
import type { InstructionEditingActions } from "./AgentInstructions";
import { AgentInstructions } from "./AgentInstructions";
const recorder = vi.hoisted(() => ({
  status: "recording",
  elapsedSeconds: 4,
  levels: [0.2, 0.6, 0.3],
  error: null,
  cancel: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("../../features/agents/voice/useVoiceNoteRecorder", () => ({
  useVoiceNoteRecorder: () => recorder,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function setup() {
  recorder.status = "recording";
  recorder.stop.mockImplementation(async () => {
    recorder.status = "idle";
    return {
      file: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
    };
  });
  const onChange = vi.fn();
  render(
    <AgentInstructions
      value="Existing instructions"
      disabled={false}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  return onChange;
}
it("transcribes locally, sends only text for drafting, and requires explicit apply", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce("Help me plan trips")
    .mockResolvedValueOnce("Plan trips for the user.");
  const onChange = setup();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Instruction draft")).toHaveValue(
      "Plan trips for the user.",
    ),
  );
  expect(invoke).toHaveBeenNthCalledWith(1, "agent_instruction_transcribe", {
    audio: "AQID",
  });
  expect(invoke).toHaveBeenNthCalledWith(2, "agent_instruction_generate", {
    transcript: "Help me plan trips",
  });
  expect(onChange).not.toHaveBeenCalled();
  recorder.status = "idle";
  // The real recorder becomes idle before its stop promise resolves.
  fireEvent.change(screen.getByLabelText("Instruction draft"), {
    target: { value: "Plan short trips." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use instructions" }));
  expect(onChange).toHaveBeenCalledWith("Plan short trips.");
  recorder.status = "recording";
});
it("shows a re-record action after failure and ignores results after unmount", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce("Be a travel helper")
    .mockRejectedValueOnce("Model unavailable");
  setup();
  expect(
    screen.queryByRole("button", { name: "Back" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Model unavailable"),
  );
  expect(screen.queryByLabelText("Transcript")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Re-record" }));
  expect(recorder.start).toHaveBeenCalled();
  cleanup();
  vi.clearAllMocks();
  let resolve!: (value: string) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }) as ReturnType<typeof invoke>,
  );
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  cleanup();
  await act(async () => resolve("Cancelled speech"));
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("offers choices and retains text when returning to them", () => {
  recorder.status = "idle";
  render(
    <AgentInstructions
      value="Keep this draft"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Text" }));
  expect(screen.getByLabelText("Agent instructions")).toHaveValue(
    "Keep this draft",
  );
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  expect(recorder.start).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
});

it("closing embedded editing preserves existing instructions until explicit apply", async () => {
  recorder.status = "recording";
  recorder.stop.mockImplementation(async () => {
    recorder.status = "idle";
    return { file: { arrayBuffer: async () => new Uint8Array([1]).buffer } };
  });
  vi.mocked(invoke)
    .mockResolvedValueOnce("New description")
    .mockResolvedValueOnce("New generated instructions");
  const editingRef = createRef<InstructionEditingActions>();
  const onChange = vi.fn();
  render(
    <AgentInstructions
      embedded
      editingRef={editingRef}
      value="Existing cloned instructions"
      disabled={false}
      onChange={onChange}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Agent instructions" }));
  fireEvent.click(screen.getByRole("button", { name: "Audio" }));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Instruction draft")).toHaveValue(
      "New generated instructions",
    ),
  );
  act(() => editingRef.current?.done());
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByText("Existing cloned instructions")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Agent instructions" }));
  fireEvent.click(screen.getByRole("button", { name: "Audio" }));
  fireEvent.click(screen.getByRole("button", { name: "Use instructions" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(
    "New generated instructions",
  );
});
