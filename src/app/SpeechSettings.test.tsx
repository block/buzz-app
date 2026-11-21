// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  ON_DEVICE_SPEECH,
  type ListenOptions,
  type SpeechChoice,
} from "../features/speech/service";
import { SpeechSettings } from "./SpeechSettings";

afterEach(cleanup);

const HOSTED = "example.speech/main";
const choices: SpeechChoice[] = [
  { key: HOSTED, label: "Example", description: "A hosted provider." },
  { key: ON_DEVICE_SPEECH, label: "On this Mac", description: "On device." },
];

/** The speech service as Settings uses it, with the listen held for the
 * test to drive. */
function fake(initial: string | undefined, providers = choices) {
  let backend = initial;
  const listeners = new Set<() => void>();
  let options: ListenOptions | undefined;
  const stop = vi.fn();
  const speech = {
    backend: () => backend,
    status: () => (backend ? ("ready" as const) : ("unavailable" as const)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setBackend: vi.fn((key: string) => {
      backend = key;
      for (const listener of listeners) listener();
    }),
    providers: () => providers,
    statusOf: () => "ready" as const,
    prepare: vi.fn(),
    listen: vi.fn((next: ListenOptions) => {
      options = next;
      return { stop, cancel: vi.fn() };
    }),
  };
  const listen = () => {
    if (!options) throw new Error("not listening");
    return options;
  };
  return { speech, listen, stop };
}

it("chooses the provider, and tries it with the community it bills", async () => {
  const user = userEvent.setup();
  const { speech, listen, stop } = fake(ON_DEVICE_SPEECH);
  render(
    <SpeechSettings
      speech={speech}
      community="wss://relay.example.org"
      active={() => true}
    />,
  );
  expect(screen.getByRole("radio", { name: /On this Mac/ })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: /Example/ }));
  expect(speech.setBackend).toHaveBeenCalledWith(HOSTED);
  expect(screen.getByRole("radio", { name: /Example/ })).toBeChecked();

  await user.click(screen.getByRole("button", { name: "Start listening" }));
  expect(speech.prepare).toHaveBeenCalledOnce();
  expect(speech.listen).toHaveBeenCalledWith(
    expect.objectContaining({ community: "wss://relay.example.org" }),
  );
  act(() => listen().onState?.("listening"));
  expect(screen.getByRole("status")).toHaveTextContent("Listening…");
  act(() => listen().onText("hello"));
  expect(screen.getByRole("status")).toHaveTextContent("hello");
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalledOnce();
  act(() => {
    listen().onEnd("Hello.");
    listen().onState?.("idle");
  });
  expect(screen.getByRole("status")).toHaveTextContent("Hello.");
  expect(screen.getByRole("button", { name: "Start listening" })).toBeEnabled();
});

it("shows why a try failed", async () => {
  const user = userEvent.setup();
  const { speech, listen } = fake(ON_DEVICE_SPEECH);
  render(<SpeechSettings speech={speech} active={() => true} />);
  await user.click(screen.getByRole("button", { name: "Start listening" }));
  act(() => {
    listen().onError?.("denied", "Allow the microphone.");
    listen().onState?.("idle");
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Allow the microphone.");
});

it("needs a community to try a hosted provider", () => {
  const { speech } = fake(HOSTED);
  render(<SpeechSettings speech={speech} active={() => true} />);
  expect(
    screen.getByRole("button", { name: "Start listening" }),
  ).toBeDisabled();
  expect(screen.getByText(/Select a community/)).toBeInTheDocument();
});

it("points to plugins when no provider is available", () => {
  const { speech } = fake(undefined, []);
  render(<SpeechSettings speech={speech} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "No speech provider is available",
  );
});
