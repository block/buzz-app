import { expect, it, vi } from "vitest";
import type { Context } from "../../plugins/author";
import { apply, inject } from "./index";

it("adds one Watching tab to agents' settings", () => {
  const registerTab = vi.fn();
  apply({
    agents: { registerTab },
    relay: {},
    navigation: {},
  } as unknown as Context);
  expect(inject).toEqual(["agents", "relay", "navigation"]);
  expect(registerTab).toHaveBeenCalledOnce();
  expect(registerTab).toHaveBeenCalledWith(
    expect.objectContaining({ id: "watching", title: "Watching" }),
  );
});
