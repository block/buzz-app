import { describe, expect, it, vi } from "vitest";
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
  await f.access
    .forRecipient({ ...f.recipient, scope: "community:other" })
    .grant("second");
  await expect(
    f.access.execute(
      "agent",
      { channel: "chat", root: "thread" },
      { action: "observe" },
    ),
  ).rejects.toThrow(/^unavailable: More than one/);
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

describe("execute error codes", () => {
  it("prefixes a caller with no shared browser with unavailable", async () => {
    const f = fixture();
    await expect(
      f.access.execute(
        "agent",
        { channel: "chat", root: "thread" },
        { action: "observe" },
      ),
    ).rejects.toThrow(/^unavailable: /);
  });

  it("prefixes a revoke during the native call with not_visible", async () => {
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
    const rejected = expect(reading).rejects.toThrow(/^not_visible: /);
    await f.control.revoke("view");
    finish({ text: "secret page" });
    await rejected;
  });

  it.each([
    {
      failure: "an ineligible recipient",
      message: "Choose an agent running in this Buzz conversation.",
      grant: (f: ReturnType<typeof fixture>) => {
        f.stop();
        return f.control.grant("view");
      },
    },
    {
      failure: "a revoke during the native grant",
      message: "Browser access was revoked.",
      grant: async (f: ReturnType<typeof fixture>) => {
        let finish!: (grant: { token: string; revision: number }) => void;
        vi.mocked(f.native.grant).mockReturnValue(
          new Promise((resolve) => {
            finish = resolve;
          }),
        );
        const granting = f.control.grant("view");
        await vi.waitFor(() => expect(f.native.grant).toHaveBeenCalled());
        const revoking = f.control.revoke("view");
        finish({ token: "late", revision: 1 });
        await revoking;
        return granting;
      },
    },
  ])(
    "keeps the person-facing grant message for $failure unprefixed",
    async ({ message, grant }) => {
      const f = fixture();
      await expect(grant(f)).rejects.toThrow(
        new RegExp(`^${message.replaceAll(".", "\\.")}$`),
      );
    },
  );
});

describe("one grant per recipient", () => {
  function sessions() {
    const eligible = new Set(["agent", "other"]);
    const native = {
      available: vi.fn(async () => true),
      grant: vi.fn(async (session: string) => ({
        token: `token-${session}`,
        revision: 1,
      })),
      revoke: vi.fn(async (_session: string) => {}),
      execute: vi.fn(async (_token: string, _request: unknown) => ({
        text: "Page",
      })),
    };
    const recipient: BrowserRecipient = {
      agent: "agent",
      scope: "community:owner",
      channel: "chat",
      root: "thread",
    };
    const access = new BrowserAccess(native, (candidate) =>
      eligible.has(candidate.agent),
    );
    return {
      native,
      recipient,
      access,
      eligible,
      control: access.forRecipient(recipient),
      observe: (agent = "agent") =>
        access.execute(
          agent,
          { channel: "chat", root: "thread" },
          { action: "observe" },
        ),
    };
  }

  it("cancels a pending grant on one page when the recipient is granted another", async () => {
    const f = sessions();
    let finishFirst!: (grant: { token: string; revision: number }) => void;
    f.native.grant.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    const first = f.control.grant("A");
    const rejected = expect(first).rejects.toThrow("revoked");
    await vi.waitFor(() => expect(f.native.grant).toHaveBeenCalledWith("A"));
    await f.control.grant("B");
    finishFirst({ token: "token-A", revision: 1 });
    await rejected;
    await vi.waitFor(() => expect(f.native.revoke).toHaveBeenCalledWith("A"));
    expect(f.native.revoke.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.native.grant.mock.invocationCallOrder[0] ?? Infinity,
    );
    await expect(f.observe()).resolves.toEqual({ text: "Page" });
    expect(f.native.execute).toHaveBeenLastCalledWith("token-B", {
      action: "observe",
    });
  });

  it("keeps only the newer of two completed grants and revokes the older once", async () => {
    const f = sessions();
    await f.control.grant("A");
    await f.control.grant("B");
    await vi.waitFor(() => expect(f.native.revoke).toHaveBeenCalledWith("A"));
    expect(f.native.revoke).toHaveBeenCalledTimes(1);
    await expect(f.observe()).resolves.toEqual({ text: "Page" });
    expect(f.native.execute).toHaveBeenLastCalledWith("token-B", {
      action: "observe",
    });
  });

  it("removes no grant when the new grant is refused as ineligible", async () => {
    const f = sessions();
    await f.control.grant("A");
    f.eligible.delete("agent");
    await expect(f.control.grant("B")).rejects.toThrow("Choose an agent");
    f.eligible.add("agent");
    await expect(f.observe()).resolves.toEqual({ text: "Page" });
    expect(f.native.execute).toHaveBeenLastCalledWith("token-A", {
      action: "observe",
    });
    expect(f.native.revoke).not.toHaveBeenCalled();
  });

  it("leaves one agent's grant in place when another agent is granted another page", async () => {
    const f = sessions();
    await f.control.grant("A");
    await f.access.forRecipient({ ...f.recipient, agent: "other" }).grant("B");
    await expect(f.observe("agent")).resolves.toEqual({ text: "Page" });
    expect(f.native.execute).toHaveBeenLastCalledWith("token-A", {
      action: "observe",
    });
    await expect(f.observe("other")).resolves.toEqual({ text: "Page" });
    expect(f.native.execute).toHaveBeenLastCalledWith("token-B", {
      action: "observe",
    });
    expect(f.native.revoke).not.toHaveBeenCalled();
  });

  it("keeps the new grant usable when the native revoke of the older page fails", async () => {
    const f = sessions();
    f.native.revoke.mockRejectedValueOnce(new Error("Native connection lost"));
    await f.control.grant("A");
    await f.control.grant("B");
    await vi.waitFor(() => expect(f.native.revoke).toHaveBeenCalledWith("A"));
    await expect(f.observe()).resolves.toEqual({ text: "Page" });
    expect(f.native.execute).toHaveBeenLastCalledWith("token-B", {
      action: "observe",
    });
  });

  it("leaves no grant when the native grant fails after the older grant was removed", async () => {
    const f = sessions();
    await f.control.grant("A");
    f.native.grant.mockRejectedValueOnce(
      new Error("Show the browser before allowing control"),
    );
    await expect(f.control.grant("B")).rejects.toThrow("Show the browser");
    await expect(f.observe()).rejects.toThrow(/^unavailable: /);
    expect(f.native.execute).not.toHaveBeenCalled();
  });

  it("resolves a grant to its revision and keeps the token for native execute", async () => {
    const f = sessions();
    await expect(f.control.grant("A")).resolves.toEqual({ revision: 1 });
    await f.observe();
    expect(f.native.execute).toHaveBeenCalledWith("token-A", {
      action: "observe",
    });
  });
});

describe("a grant that ended because the page stopped being shown", () => {
  const observe = (access: BrowserAccess, agent = "agent") =>
    access.execute(
      agent,
      { channel: "chat", root: "thread" },
      { action: "observe" },
    );

  it("answers not_visible after the toolbar cleans up a hidden page's grant", async () => {
    const f = fixture();
    await f.control.grant("view");
    f.access.ended("view", 2);
    await f.control.revoke("view");
    await expect(observe(f.access)).rejects.toThrow(/^not_visible: /);
    expect(f.native.execute).not.toHaveBeenCalled();
  });

  it("answers not_visible after the page closed", async () => {
    const f = fixture();
    await f.control.grant("view");
    f.access.ended("view");
    await f.control.revoke("view");
    await expect(observe(f.access)).rejects.toThrow(/^not_visible: /);
  });

  it("ignores an ended report from before the grant", async () => {
    const f = fixture();
    vi.mocked(f.native.grant).mockResolvedValue({
      token: "internal-only",
      revision: 3,
    });
    await f.control.grant("view");
    f.access.ended("view", 2);
    await expect(observe(f.access)).resolves.toEqual({ text: "Page" });
  });

  it("gives the old agent unavailable once the person shares the page with another agent", async () => {
    const f = fixture();
    await f.control.grant("view");
    f.access.ended("view", 2);
    await f.control.revoke("view");
    await f.access
      .forRecipient({ ...f.recipient, agent: "other" })
      .grant("view");
    await expect(observe(f.access)).rejects.toThrow(/^unavailable: /);
    await expect(observe(f.access, "other")).resolves.toEqual({
      text: "Page",
    });
  });

  it("uses a newer grant on another page and forgets the ended one", async () => {
    const f = fixture();
    vi.mocked(f.native.grant).mockImplementation(async (session) => ({
      token: `token-${session}`,
      revision: 1,
    }));
    await f.control.grant("A");
    f.access.ended("A", 2);
    await f.control.grant("B");
    await expect(observe(f.access)).resolves.toEqual({ text: "Page" });
    expect(f.native.execute).toHaveBeenLastCalledWith("token-B", {
      action: "observe",
    });
    await f.control.revoke("B");
    await expect(observe(f.access)).rejects.toThrow(/^unavailable: /);
  });

  it("gives unavailable once the agent is no longer eligible", async () => {
    const f = fixture();
    await f.control.grant("view");
    f.access.ended("view", 2);
    f.stop();
    await expect(observe(f.access)).rejects.toThrow(/^unavailable: /);
  });
});
