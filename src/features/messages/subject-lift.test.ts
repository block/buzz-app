import { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubjectLiftService, type SubjectLift } from "./subject-lift";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke);
beforeEach(() => vi.stubGlobal("navigator", { platform: "MacIntel" }));
afterEach(() => {
  native.mockReset();
  vi.unstubAllGlobals();
});

const relayUrl = `https://relay.test/media/${"a".repeat(64)}.jpg`;
const source = `buzz-media://localhost/${encodeURIComponent(relayUrl)}`;
// A valid 1×1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

/** Reads the service the way a plugin does: as an optional service. */
async function plugin() {
  const root = new Context();
  new SubjectLiftService(root);
  let lift: SubjectLift | undefined;
  await root
    .plugin((ctx) => {
      lift = ctx.reflect.get("subjectLift");
    })
    .await();
  if (!lift) throw new Error("subjectLift was not provided");
  return lift;
}

it("lifts a desktop media image into an uploadable PNG", async () => {
  native.mockResolvedValue(PNG.buffer);
  const lift = await plugin();
  expect(lift.supports(source)).toBe(true);
  const file = await lift.lift(source);
  expect(native).toHaveBeenCalledExactlyOnceWith("media_lift_subject", {
    source,
  });
  expect(file.type).toBe("image/png");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
});

it("refuses media or platforms the host cannot lift without calling it", async () => {
  const lift = await plugin();
  expect(lift.supports(relayUrl)).toBe(false);
  await expect(lift.lift(relayUrl)).rejects.toThrow(
    "Lifting a subject is available in the Mac app",
  );
  vi.stubGlobal("navigator", { platform: "Win32" });
  expect(lift.supports(source)).toBe(false);
  await expect(lift.lift(source)).rejects.toThrow(
    "Lifting a subject is available in the Mac app",
  );
  expect(native).not.toHaveBeenCalled();
});

it("rejects with the host's reason, or a generic one", async () => {
  const lift = await plugin();
  native.mockRejectedValueOnce("No subject found in this image");
  await expect(lift.lift(source)).rejects.toThrow(
    "No subject found in this image",
  );
  native.mockRejectedValueOnce({ code: 500 });
  await expect(lift.lift(source)).rejects.toThrow("Could not lift the subject");
});

it("stops when aborted, before or during the host's work", async () => {
  const lift = await plugin();
  await expect(lift.lift(source, AbortSignal.abort())).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(native).not.toHaveBeenCalled();

  let finish!: (png: ArrayBuffer) => void;
  native.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const controller = new AbortController();
  const lifting = lift.lift(source, controller.signal);
  controller.abort();
  finish(PNG.buffer);
  await expect(lifting).rejects.toMatchObject({ name: "AbortError" });
});
