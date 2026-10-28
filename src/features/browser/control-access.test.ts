import { expect, it, vi } from "vitest";
import { BrowserAccess, type BrowserRecipient } from "./control-access";
import type { BrowserControl } from "./platform";

function fixture() {
  let eligible = true;
  const native: BrowserControl = {
    available: vi.fn(async () => true),
    grant: vi.fn(async () => ({ token: "internal-only", revision: 1 })),
    revoke: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ text: "Page" })),
  };
  const recipient: BrowserRecipient = {
    agent: "agent",
    scope: "community:owner",
    channel: "chat",
    root: "thread",
  };
  const access = new BrowserAccess(native, () => eligible);
  return {
    native,
    recipient,
    access,
    control: access.forRecipient(recipient),
    stop: () => {
      eligible = false;
    },
  };
}

it("uses the internal grant only for the assigned caller and exact conversation", async () => {
  const f = fixture();
  await f.control.grant("view");
  await expect(
    f.access.execute(
      "other",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  await expect(
    f.access.execute(
      "agent",
      { channel: "other", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  await expect(
    f.access.execute("agent", { channel: "chat" }, { action: "observe" }),
  ).rejects.toThrow("No browser");
  await expect(
    f.access.execute(
      "agent",
      { channel: "chat", root: "thread", topLevel: true },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  expect(f.native.execute).not.toHaveBeenCalled();
  await expect(
    f.access.execute(
      "agent",
      { channel: "chat", root: "thread", wholeChannel: true },
      { action: "observe" },
    ),
  ).resolves.toEqual({ text: "Page" });
  expect(f.native.execute).toHaveBeenCalledWith("internal-only", {
    action: "observe",
  });
  await f.control.revoke("view");
  await expect(
    f.access.execute(
      "agent",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
});

it("rejects a grant or operation once the recipient is no longer eligible", async () => {
  const f = fixture();
  await f.control.grant("view");
  f.stop();
  await expect(
    f.access.execute(
      "agent",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
  await expect(f.control.grant("view")).rejects.toThrow("Choose an agent");
  expect(f.native.execute).not.toHaveBeenCalled();
});

it("does not install a grant completed after takeover", async () => {
  const f = fixture();
  let finish!: (grant: { token: string; revision: number }) => void;
  vi.mocked(f.native.grant).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const granting = f.control.grant("view");
  const rejected = expect(granting).rejects.toThrow("revoked");
  await vi.waitFor(() => expect(f.native.grant).toHaveBeenCalled());
  const revoking = f.control.revoke("view");
  finish({ token: "late", revision: 1 });
  await revoking;
  await rejected;
  await expect(
    f.access.execute(
      "agent",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("No browser");
});

it("suppresses results after takeover, even when native execution succeeds late", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  vi.mocked(f.native.execute).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await f.control.grant("view");
  const reading = f.access.execute(
    "agent",
    { channel: "chat", root: "thread" },
    { action: "observe" },
  );
  const rejected = expect(reading).rejects.toThrow("revoked");
  await f.control.revoke("view");
  finish({ text: "secret page" });
  await rejected;
});

it("refuses an ambiguous conversation rather than choosing another browser", async () => {
  const f = fixture();
  await f.control.grant("first");
  await f.control.grant("second");
  await expect(
    f.access.execute(
      "agent",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow("More than one");
  expect(f.native.execute).not.toHaveBeenCalled();
});

it("orders replacement grants so a late old grant cannot revoke the new recipient", async () => {
  const f = fixture();
  let finish!: (grant: { token: string; revision: number }) => void;
  vi.mocked(f.native.grant).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = f.control.grant("view");
  const rejected = expect(first).rejects.toThrow("revoked");
  await vi.waitFor(() => expect(f.native.grant).toHaveBeenCalledTimes(1));
  const revoke = f.control.revoke("view");
  const secondControl = f.access.forRecipient({
    ...f.recipient,
    agent: "second",
  });
  const second = secondControl.grant("view");
  finish({ token: "old", revision: 1 });
  await rejected;
  await revoke;
  await second;
  await f.control.revoke("view"); // old recipient cleanup cannot touch the new grant
  expect(f.native.revoke).toHaveBeenCalledTimes(1);
  await expect(
    f.access.execute(
      "second",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).resolves.toEqual({ text: "Page" });
});
