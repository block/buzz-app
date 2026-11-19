import { afterEach, expect, it, vi } from "vitest";
import type { RelayFetch } from "./find-community";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// BUZZ_COMPATIBLE_RELAY_SOFTWARE is read once at module load, so each case
// stubs the build value and imports a fresh copy of the module.
async function findWith(compatible: string, info: Record<string, unknown>) {
  vi.stubEnv("VITE_BUZZ_COMPATIBLE_RELAY_SOFTWARE", compatible);
  vi.resetModules();
  const { findCommunity } = await import("./find-community");
  const request = vi.fn<RelayFetch>((_origin, path) =>
    Promise.resolve(
      path === "/"
        ? Response.json(info)
        : new Response("not found", { status: 404 }),
    ),
  );
  return findCommunity(
    "https://relay.example.org",
    request,
    new AbortController().signal,
  ).then(
    (found) => found.name,
    (error: { failure?: string }) => error.failure,
  );
}

afterEach(() => vi.unstubAllEnvs());

const other = { name: "example", software: "example-relay 0.3", self: "" };

it("accepts relay software the build names as compatible", async () => {
  await expect(findWith(" other-relay , example-relay", other)).resolves.toBe(
    "example",
  );
});

it("keeps refusing other relay software when the build names none", async () => {
  await expect(findWith("", other)).resolves.toBe("not-buzz");
  await expect(findWith("other-relay", other)).resolves.toBe("not-buzz");
});
