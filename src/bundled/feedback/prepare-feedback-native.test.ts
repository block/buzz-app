// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ getVersion: vi.fn(async () => "3.2.1") }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: native.getVersion }));

import { feedbackDiagnostics } from "./prepare-feedback";

it("includes the native app version only after diagnostics opt-in", async () => {
  expect(native.getVersion).not.toHaveBeenCalled();
  const file = await feedbackDiagnostics(new Date("2026-09-24T00:00:00Z"));
  expect(native.getVersion).toHaveBeenCalledOnce();
  expect(await file.text()).toContain("app version: 3.2.1");
});
