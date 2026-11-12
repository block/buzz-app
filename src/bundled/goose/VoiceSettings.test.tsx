// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceSettings } from "./VoiceSettings";
import { GooseVoiceSettings } from "./voice-settings";
import { fakeSpawn } from "./goose-testing";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const endpoint = "GOOSE_LIVE_VOICE_ENDPOINT";
const key = "GOOSE_LIVE_VOICE_API_KEY";

it("shows shared config, clears Saved on endpoint edits, and requires a new key", async () => {
  const config = new Map<string, unknown>([
    [endpoint, "http://a.example.org/live"],
    [key, "token-a"],
  ]);
  const settings = new GooseVoiceSettings(
    fakeSpawn({ config }),
    localStorage,
    () => {},
  );
  const user = userEvent.setup();
  render(<VoiceSettings settings={settings} />);
  await user.click(screen.getByRole("button", { name: "Goose voice" }));
  const field = await screen.findByLabelText("Sessions endpoint");
  expect(field).toHaveValue("http://a.example.org/live");
  expect(screen.getByLabelText("API key")).toHaveValue("");
  expect(screen.getByText("Saved. Leave blank to keep it.")).toBeVisible();
  expect(screen.getByText(/Not encrypted/)).toBeVisible();
  expect(screen.getByRole("switch")).not.toBeChecked();
  fireEvent.change(field, { target: { value: "http://b.example.org/live" } });
  expect(
    screen.queryByText("Saved. Leave blank to keep it."),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save voice settings" }),
  ).toBeDisabled();
  await user.type(screen.getByLabelText("API key"), "token-b");
  await user.click(screen.getByRole("button", { name: "Save voice settings" }));
  await waitFor(() =>
    expect(config.get(endpoint)).toBe("http://b.example.org/live"),
  );
  await waitFor(() => expect(screen.getByLabelText("API key")).toHaveValue(""));
  expect(config.get(key)).toBe("token-b");
});

it("rereads config and shows the disabled switch after a partial save fails", async () => {
  const config = new Map<string, unknown>([
    [endpoint, "http://a.example.org/live"],
    [key, "token-a"],
  ]);
  const settings = new GooseVoiceSettings(
    fakeSpawn({
      config,
      configWrite: async (method, params) => {
        if (method.endsWith("/upsert") && params.key === endpoint)
          throw new Error("write failed");
      },
    }),
    localStorage,
    () => {},
  );
  await settings.setEnabled(true);
  const user = userEvent.setup();
  render(<VoiceSettings settings={settings} />);
  await user.click(screen.getByRole("button", { name: "Goose voice" }));
  await screen.findByLabelText("Sessions endpoint");
  await user.type(screen.getByLabelText("API key"), "replacement");
  await user.click(screen.getByRole("button", { name: "Save voice settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Voice is now off",
  );
  expect(screen.getByRole("switch")).not.toBeChecked();
  expect(screen.queryByLabelText("Sessions endpoint")).not.toBeInTheDocument();
  expect(config.has(key)).toBe(false);
});

it.each([false, true])(
  "never enables an unknown endpoint while read is pending or failed (enabled=%s)",
  async (enabled) => {
    const settings = new GooseVoiceSettings(
      fakeSpawn(),
      localStorage,
      () => {},
    );
    await settings.setEnabled(enabled);
    let reject!: (error: Error) => void;
    const reading = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    vi.spyOn(settings, "read").mockReturnValue(reading);
    const user = userEvent.setup();
    render(<VoiceSettings settings={settings} />);
    await user.click(screen.getByRole("button", { name: "Goose voice" }));
    const toggle = screen.getByRole("switch");
    if (enabled) expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    else expect(toggle).toHaveAttribute("aria-disabled", "true");
    reject(new Error("read failed"));
    await screen.findByRole("alert");
    if (enabled) {
      await user.click(toggle);
      await waitFor(() => expect(settings.enabled).toBe(false));
    }
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    await user.click(toggle);
    expect(settings.enabled).toBe(false);
    expect(screen.queryByLabelText("Voice model")).not.toBeInTheDocument();
  },
);
