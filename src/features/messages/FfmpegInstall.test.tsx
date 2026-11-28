// @vitest-environment jsdom
import { File } from "node:buffer";
import { invoke } from "@tauri-apps/api/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FfmpegInstall } from "./FfmpegInstall";

vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => true,
  invoke: vi.fn(),
}));

afterEach(cleanup);

it.each(["replaced", "dismissed"])(
  "skips the abandoned upload when the card is %s during installation",
  async (action) => {
    let finish!: () => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const retry = vi.fn();
    const card = (name: string) => (
      <FfmpegInstall
        file={new File(["photo"], name) as unknown as globalThis.File}
        disabled={false}
        retry={retry}
      />
    );
    const view = render(card("first.heic"));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(finish).toBeDefined());
    if (action === "replaced") view.rerender(card("second.heic"));
    else view.unmount();
    await act(async () => finish());
    expect(retry).not.toHaveBeenCalled();
  },
);
