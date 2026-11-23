// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { RelaySession } from "../relay/session";
import { writeView } from "../../shared/view-state";
import {
  draftLifetime,
  effectiveLifetime,
  effectiveVisibility,
  readDefaultVisibility,
  readWorkspaceVisibility,
  saveDefaultVisibility,
  saveWorkspaceVisibility,
  readDefaultLifetime,
  readWorkspaceLifetime,
  saveDefaultLifetime,
  saveWorkspaceLifetime,
  useAccountLifetimes,
  writeDefaultLifetime,
} from "./default-lifetime";

afterEach(() => localStorage.clear());

it("reads a saved default and treats a malformed one as ongoing", () => {
  expect(readDefaultLifetime("s")).toBeUndefined();
  expect(writeDefaultLifetime("s", 604800)).toBe(true);
  expect(readDefaultLifetime("s")).toBe(604800);
  expect(readDefaultLifetime("other")).toBeUndefined();
  for (const bad of [-1, 0, 600, 1.5, "604800", 2147483648]) {
    writeView("s", "solo:default-lifetime", bad);
    expect(readDefaultLifetime("s")).toBeUndefined();
  }
  expect(writeDefaultLifetime("s", undefined)).toBe(true);
  expect(readDefaultLifetime("s")).toBeUndefined();
});

it("a draft follows the default only when its settings chose no lifetime", () => {
  writeDefaultLifetime("s", 86400);
  expect(draftLifetime("s", {})).toBe(86400);
  expect(draftLifetime("s", { lifetimeChosen: true })).toBeUndefined();
  expect(draftLifetime("s", { ttlSeconds: 600 })).toBe(600);
  expect(draftLifetime("s", { ttlSeconds: 600, lifetimeChosen: true })).toBe(
    600,
  );
});

it("a workspace's own lifetime wins over the default until it follows again", async () => {
  writeDefaultLifetime("s", 86400);
  expect(effectiveLifetime("s", "w")).toBe(86400);
  expect(await saveWorkspaceLifetime(undefined, "s", "w", 1209600)).toBe(
    undefined,
  );
  expect(readWorkspaceLifetime("s", "w")).toBe(1209600);
  expect(effectiveLifetime("s", "w")).toBe(1209600);
  expect(effectiveLifetime("s", "other")).toBe(86400);
  expect(effectiveLifetime("s")).toBe(86400);
  await saveWorkspaceLifetime(undefined, "s", "w", null);
  expect(effectiveLifetime("s", "w")).toBeUndefined();
  expect(draftLifetime("s", {}, "w")).toBeUndefined();
  await saveWorkspaceLifetime(undefined, "s", "w", undefined);
  expect(readWorkspaceLifetime("s", "w")).toBeUndefined();
  expect(effectiveLifetime("s", "w")).toBe(86400);
  // Changing the default carries to workspaces that follow it.
  await saveDefaultLifetime(undefined, "s", 604800);
  expect(effectiveLifetime("s", "w")).toBe(604800);
});

it("saves to the account and adopts the account's choices once", async () => {
  const saved: unknown[] = [];
  const account = {
    read: async () => ({
      lifetime: 604800,
      workspaces: { w: null },
      visibility: "public",
      workspaceVisibility: { w: "private" },
    }),
    writeLifetime: async (value: number | null) => void saved.push(value),
    writeWorkspaceLifetime: async (
      id: string,
      value: number | null | undefined,
    ) => void saved.push([id, value]),
  };
  const session = { accountSettings: account } as unknown as RelaySession;
  const { unmount } = renderHook(() => useAccountLifetimes(session, "s"));
  await waitFor(() => expect(readDefaultLifetime("s")).toBe(604800));
  expect(readWorkspaceLifetime("s", "w")).toBeNull();
  expect(readDefaultVisibility("s")).toBe("public");
  expect(readWorkspaceVisibility("s", "w")).toBe("private");
  unmount();
  expect(await saveDefaultLifetime(session, "s", 86400)).toBeUndefined();
  expect(await saveWorkspaceLifetime(session, "s", "w", undefined)).toBe(
    undefined,
  );
  expect(saved).toEqual([86400, ["w", undefined]]);
  account.writeLifetime = async () => {
    throw new Error("offline");
  };
  expect(await saveDefaultLifetime(session, "s", 604800)).toBe(
    "Couldn’t save this. Try again.",
  );
});

it("starts new conversations private unless the account or workspace chose public", async () => {
  expect(effectiveVisibility("s")).toBe("private");
  writeView("s", "solo:default-visibility", "open");
  expect(effectiveVisibility("s", "w")).toBe("private");
  const saved: unknown[] = [];
  const session = {
    accountSettings: {
      writeVisibility: async (value: string) => void saved.push(value),
      writeWorkspaceVisibility: async (id: string, value?: string) =>
        void saved.push([id, value]),
    },
  } as unknown as RelaySession;
  expect(await saveWorkspaceVisibility(session, "s", "w", "public")).toBe(
    undefined,
  );
  expect(effectiveVisibility("s")).toBe("private");
  expect(effectiveVisibility("s", "w")).toBe("public");
  expect(await saveDefaultVisibility(session, "s", "public")).toBeUndefined();
  expect(await saveWorkspaceVisibility(session, "s", "w", undefined)).toBe(
    undefined,
  );
  expect(effectiveVisibility("s", "w")).toBe("public");
  expect(saved).toEqual([["w", "public"], "public", ["w", undefined]]);
});
