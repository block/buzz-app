import { afterEach, expect, it, vi } from "vitest";
import type { HostMcpServer } from "../host/service";
import type { Agents } from "./service";
import {
  createExternalApps,
  legacyRequest,
  parseExternalAuthorization,
  type ExternalApps,
  type ExternalAuthorization,
} from "./external-connection";

const request: ExternalAuthorization = {
  version: 1,
  client: "Test client",
  callback: "http://127.0.0.1:1234/buzz/authorize",
  state: "A".repeat(43),
  scope: ["agent"],
  code_challenge: `${"B".repeat(42)}A`,
  code_challenge_method: "S256",
};
const uri = () =>
  `buzz://mcp-authorize?${new URLSearchParams({ version: "1", client: request.client, callback: request.callback, state: request.state, scope: "agent", code_challenge: request.code_challenge, code_challenge_method: "S256" })}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function transport() {
  const ended = deferred<void>();
  return {
    url: "http://127.0.0.1:1234/mcp",
    headers: [{ name: "Authorization", value: "Bearer test-only-token" }],
    closed: ended.promise,
    authorize: vi.fn(async () => {}),
    close: vi.fn(async () => ended.resolve()),
  };
}
function approvePending(connection: ExternalApps, agent: string) {
  const pending = connection.snapshot().pending;
  if (!pending) throw new Error("No request is pending.");
  return connection.approve(pending.request, agent);
}
afterEach(() => vi.useRealTimers());
it("parses the generic authorization request without a bearer", () => {
  expect(parseExternalAuthorization(uri())).toEqual(request);
});
it.each(["agent", "read", "post", "create", "read create", "read post create"])(
  "parses explicitly requested access without adding scopes (%s)",
  (scope) => {
    const url = new URL(uri());
    url.searchParams.set("scope", scope);
    expect(parseExternalAuthorization(url.href)?.scope).toEqual(
      scope.split(" "),
    );
  },
);
it.each([
  ["callback", "http://localhost:1234/buzz/authorize"],
  ["callback", "https://127.0.0.1:1234/buzz/authorize"],
  ["callback", "http://127.0.0.1:1234/buzz/authorize?x=1"],
  ["callback", "http://127.0.0.1:80/buzz/authorize"],
  ["callback", "http://user@127.0.0.1:1234/buzz/authorize"],
  ["code_challenge_method", "plain"],
  ["scope", "read files"],
  ["scope", "read read"],
  ["scope", "create create"],
  ["scope", "create manage"],
  ["scope", "agent read"],
  ["scope", "agent agent"],
  ["state", "short"],
  ["client", ""],
  ["version", "3"],
])("rejects invalid %s in the authorization link", (key, value) => {
  const url = new URL(uri());
  url.searchParams.set(key, value);
  expect(parseExternalAuthorization(url.href)).toBeNull();
});

const savedPairing = {
  id: "C".repeat(43),
  approval: {
    client: "Test client",
    viewer: "viewer",
    agent: "test-agent",
    community: "https://example.test",
    scopes: ["read"] as const,
  },
  expires_at: 2_000_000_000,
};
const resumeRequest: ExternalAuthorization = {
  ...request,
  version: 2,
  scope: ["read"],
  resume: { id: savedPairing.id, counter: 1, proof: "A".repeat(43) },
};

it("restores saved approval and closes only the session on unload", async () => {
  const server = transport();
  const pairing = vi.fn(async (_operation: string) => savedPairing);
  const connection = createExternalApps();
  const unbind = connection.bind({
    connect: async () => server,
    deny: async () => {},
    pairing,
  });
  await vi.waitFor(() =>
    expect(connection.snapshot().pairing).toEqual(savedPairing),
  );
  connection.open(resumeRequest, "viewer");
  await vi.waitFor(() => expect(server.authorize).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(connection.snapshot().grant?.phase).toBe("waiting"),
  );
  expect(connection.snapshot().pending).toBeUndefined();
  unbind();
  expect(server.close).toHaveBeenCalled();
  expect(pairing.mock.calls.map((call) => call[0])).not.toContain("revoke");
});

it.each(["revoked", "proof", "viewer", "scope", "widened scope"])(
  "refuses %s resume before connection",
  async (reason) => {
    const connect = vi.fn(async () => transport());
    const pairing = vi.fn(async (operation: string) => {
      if (operation === "get") return savedPairing;
      if (reason === "revoked") return null;
      if (reason === "proof") throw new Error("Invalid pairing proof");
      return savedPairing;
    });
    const connection = createExternalApps();
    connection.bind({ connect, deny: async () => {}, pairing });
    connection.open(
      reason === "scope"
        ? { ...resumeRequest, scope: ["read", "post"] }
        : // A saved narrow approval never resumes as full access.
          reason === "widened scope"
          ? { ...resumeRequest, scope: ["agent"] }
          : resumeRequest,
      reason === "viewer" ? "other-viewer" : "viewer",
    );
    await vi.waitFor(() =>
      expect(connection.snapshot().error).toContain("Cannot restore"),
    );
    expect(connect).not.toHaveBeenCalled();
    expect(connection.snapshot().pending).toBeUndefined();
  },
);

it.each([false, true])(
  "closes a resume result that arrives after revoke (native revoke fails: %s)",
  async (revokeFails) => {
    const result = deferred<HostMcpServer>();
    const started = deferred<void>();
    const server = transport();
    const connection = createExternalApps();
    const pairing = vi.fn(async (operation: string) => {
      if (operation === "revoke" && revokeFails)
        throw new Error("Saved approval write failed");
      return savedPairing;
    });
    connection.bind({
      connect: async () => {
        started.resolve();
        return result.promise;
      },
      deny: async () => {},
      pairing,
    });
    connection.open(resumeRequest, "viewer");
    await started.promise;
    await connection.revoke();
    result.resolve(server);
    await vi.waitFor(() => expect(server.close).toHaveBeenCalled());
    expect(server.authorize).not.toHaveBeenCalled();
    if (revokeFails) {
      // The saved approval still exists, so it stays visible for a retry.
      expect(connection.snapshot().pairing).toEqual(savedPairing);
      expect(connection.snapshot().grant?.phase).toBe("ended");
      expect(connection.snapshot().error).toContain("Cannot revoke");
    } else {
      expect(connection.snapshot().pairing).toBeUndefined();
      expect(connection.snapshot().grant).toBeUndefined();
    }
  },
);

it("closes a failed resume without revoking saved approval", async () => {
  const server = transport();
  server.authorize.mockRejectedValueOnce(new Error("Callback lost"));
  const pairing = vi.fn(async (_operation: string) => savedPairing);
  const connection = createExternalApps();
  connection.bind({
    connect: async () => server,
    deny: async () => {},
    pairing,
  });
  connection.open(resumeRequest, "viewer");
  await vi.waitFor(() =>
    expect(connection.snapshot().error).toContain("Cannot restore"),
  );
  expect(server.close).toHaveBeenCalled();
  expect(pairing.mock.calls.map((call) => call[0])).not.toContain("revoke");
});

it("keeps pending owner consent when reconnect proof fails", async () => {
  const server = transport();
  const authorizing = deferred<void>();
  const started = deferred<void>();
  server.authorize.mockImplementationOnce(async () => {
    started.resolve();
    await authorizing.promise;
  });
  const connection = createExternalApps();
  connection.bind({
    connect: async () => server,
    deny: async () => {},
    pairing: async (operation) => {
      if (operation === "resume") throw new Error("Invalid proof");
      return null;
    },
  });
  connection.open(request, "viewer");
  const approving = approvePending(connection, "test-agent");
  await started.promise;
  try {
    connection.open(resumeRequest, "viewer");
    await vi.waitFor(() =>
      expect(connection.snapshot().error).toContain("Cannot restore"),
    );
  } finally {
    authorizing.resolve();
    await approving;
  }
  expect(connection.snapshot().grant?.phase).toBe("waiting");
  await server.close();
  await vi.waitFor(() =>
    expect(connection.snapshot().grant?.phase).toBe("ended"),
  );
});

it.each(["proof", "connect"])(
  "loads saved approval after queued reconnect fails at %s",
  async (failure) => {
    const loaded = deferred<typeof savedPairing>();
    const connection = createExternalApps();
    connection.open(resumeRequest, "viewer");
    connection.bind({
      connect: async () => {
        throw new Error("Agent is unavailable");
      },
      deny: async () => {},
      pairing: async (operation) => {
        if (operation === "get") return loaded.promise;
        if (operation === "resume" && failure === "proof")
          throw new Error("Invalid proof");
        return savedPairing;
      },
    });
    await vi.waitFor(() =>
      expect(connection.snapshot().error).toContain("Cannot restore"),
    );
    loaded.resolve(savedPairing);
    await vi.waitFor(() =>
      expect(connection.snapshot().pairing).toEqual(savedPairing),
    );
    expect(connection.snapshot().grant).toMatchObject({
      agent: "test-agent",
      phase: "ended",
    });
    await connection.revoke();
    expect(connection.snapshot().pairing).toBeUndefined();
  },
);

it("observes the current session close after reconnect fails", async () => {
  const server = transport();
  const connection = createExternalApps();
  const connect = vi
    .fn<Agents["connectExternal"]>()
    .mockResolvedValueOnce(server)
    .mockRejectedValueOnce(new Error("Agent is unavailable"));
  connection.bind({
    connect,
    deny: async () => {},
    pairing: async () => savedPairing,
  });
  connection.open(request, "viewer");
  await approvePending(connection, "test-agent");
  connection.open(resumeRequest, "viewer");
  await vi.waitFor(() =>
    expect(connection.snapshot().error).toContain("Cannot restore"),
  );
  await server.close();
  await vi.waitFor(() =>
    expect(connection.snapshot().grant?.phase).toBe("ended"),
  );
});

it("keeps saved approval visible when the initial callback fails", async () => {
  const server = transport();
  let saved = false;
  server.authorize.mockImplementationOnce(async () => {
    saved = true;
    throw new Error("Callback lost");
  });
  const pairing = vi.fn(async (operation: string) => {
    if (operation === "revoke") {
      saved = false;
      return null;
    }
    return saved ? savedPairing : null;
  });
  const connection = createExternalApps();
  connection.bind({
    connect: async () => server,
    deny: async () => {},
    pairing,
  });
  connection.open({ ...request, version: 2 }, "viewer");
  await approvePending(connection, "test-agent");
  expect(connection.snapshot().pairing).toEqual(savedPairing);
  expect(connection.snapshot().grant?.phase).toBe("ended");
  await connection.revoke();
  expect(saved).toBe(false);
});

it("refuses a late initial approval while native revoke is pending", async () => {
  const server = transport();
  const connecting = deferred<HostMcpServer>();
  const connectStarted = deferred<void>();
  const revokeStarted = deferred<void>();
  const revoking = deferred<null>();
  let revokeCount = 0;
  const connection = createExternalApps();
  connection.bind({
    connect: async () => {
      connectStarted.resolve();
      return connecting.promise;
    },
    deny: async () => {},
    pairing: async (operation) => {
      if (operation === "revoke" && ++revokeCount === 2) {
        revokeStarted.resolve();
        return revoking.promise;
      }
      return null;
    },
  });
  connection.open({ ...request, version: 2 }, "viewer");
  const approving = approvePending(connection, "test-agent");
  await connectStarted.promise;
  const revoked = connection.revoke();
  await revokeStarted.promise;
  connecting.resolve(server);
  await approving;
  expect(server.authorize).not.toHaveBeenCalled();
  expect(server.close).toHaveBeenCalled();
  revoking.resolve(null);
  await revoked;
  expect(connection.snapshot().grant).toBeUndefined();
});
it("rejects ambiguous and extra link fields", () => {
  expect(parseExternalAuthorization(`${uri()}&scope=read`)).toBeNull();
  expect(parseExternalAuthorization(`${uri()}&token=secret`)).toBeNull();
  expect(
    parseExternalAuthorization(
      uri().replace("mcp-authorize?", "mcp-authorize/extra/../?"),
    ),
  ).toBeNull();
});
it.each([
  { scope: ["read", "post"] },
  { scope: ["create"] },
  { scope: ["read", "post", "create"] },
] as const)(
  "denies a limited $scope request instead of approving it",
  async ({ scope }) => {
    const connect = vi.fn(async () => transport()),
      deny = vi.fn(async () => {});
    const connection = createExternalApps();
    connection.bind({ connect, deny });
    connection.open({ ...request, scope }, "viewer");
    await approvePending(connection, "test-agent");
    expect(connect).not.toHaveBeenCalled();
    expect(deny).toHaveBeenCalledOnce();
    expect(connection.snapshot().pending).toBeUndefined();
    expect(connection.snapshot().error).toBe(legacyRequest);
  },
);
it.each([{ scope: ["agent"] }] as const)(
  "requires approval for exactly $scope and hides transport credentials",
  async ({ scope }) => {
    const server = transport(),
      connect = vi.fn(async () => server),
      deny = vi.fn(async () => {});
    const connection = createExternalApps();
    connection.bind({ connect, deny });
    connection.open({ ...request, scope }, "viewer");
    expect(connect).not.toHaveBeenCalled();
    await approvePending(connection, "test-agent");
    expect(connect).toHaveBeenCalledWith(
      "test-agent",
      expect.any(AbortSignal),
      expect.any(Function),
      scope,
    );
    expect(server.authorize).toHaveBeenCalledWith({
      callback: request.callback,
      state: request.state,
      code_challenge: request.code_challenge,
    });
    expect(JSON.stringify(connection.snapshot())).not.toContain(
      "test-only-token",
    );
    connection.open({ ...request, state: "B".repeat(43) }, "viewer");
    expect(server.close).not.toHaveBeenCalled();
    await connection.deny();
    expect(deny).toHaveBeenCalledOnce();
    expect(server.close).not.toHaveBeenCalled();
    expect(connection.snapshot().grant?.phase).toBe("waiting");
    await connection.revoke();
    expect(server.close).toHaveBeenCalled();
  },
);
it("closes a server that starts after revocation", async () => {
  const pending = deferred<HostMcpServer>(),
    started = deferred<void>();
  const server = transport();
  const connection = createExternalApps();
  connection.bind({
    connect: async () => {
      started.resolve();
      return pending.promise;
    },
    deny: async () => {},
  });
  connection.open(request, "viewer");
  const approving = approvePending(connection, "test-agent");
  try {
    await started.promise;
    await connection.revoke();
  } finally {
    pending.resolve(server);
  }
  await approving;
  expect(server.close).toHaveBeenCalledOnce();
  expect(server.authorize).not.toHaveBeenCalled();
});
it("denies and expires requests without creating a grant", async () => {
  vi.useFakeTimers();
  const connect = vi.fn(),
    deny = vi.fn(async () => {});
  const connection = createExternalApps();
  connection.bind({ connect, deny });
  connection.open(request, "viewer");
  await connection.deny();
  expect(deny).toHaveBeenCalledOnce();
  connection.open(request, "viewer");
  await vi.advanceTimersByTimeAsync(300_000);
  expect(connection.snapshot().pending).toBeUndefined();
  expect(deny).toHaveBeenCalledTimes(2);
  expect(connect).not.toHaveBeenCalled();
});
it.each([false, true])(
  "closes the grant when callback delivery fails (closed first: %s)",
  async (closedFirst) => {
    const server = transport();
    server.authorize.mockImplementationOnce(async () => {
      if (closedFirst) await server.close();
      throw new Error("callback failed");
    });
    const connection = createExternalApps();
    connection.bind({ connect: async () => server, deny: async () => {} });
    connection.open(request, "viewer");
    await approvePending(connection, "test-agent");
    expect(server.close).toHaveBeenCalled();
    expect(connection.snapshot().error).toContain("Start setup again");
  },
);

it("keeps a replacement grant visible while an older failure closes", async () => {
  const first = transport(),
    second = transport();
  const started = deferred<void>(),
    finish = deferred<void>();
  const close = first.close;
  first.authorize.mockRejectedValueOnce(new Error("callback failed"));
  first.close = vi.fn(async () => {
    started.resolve();
    await finish.promise;
    await close();
  });
  const connect = vi
    .fn<Agents["connectExternal"]>()
    .mockResolvedValueOnce(first)
    .mockImplementationOnce(async (_agent, _signal, connected) => {
      connected();
      return second;
    });
  const connection = createExternalApps();
  connection.bind({ connect, deny: async () => {} });
  connection.open(request, "viewer");
  const failed = approvePending(connection, "first-agent");
  try {
    await started.promise;
    connection.open(
      { ...request, client: "Second client", state: "B".repeat(43) },
      "viewer",
    );
    await approvePending(connection, "second-agent");
    expect(connection.snapshot().grant).toMatchObject({
      agent: "second-agent",
      phase: "connected",
    });
  } finally {
    finish.resolve();
    await failed;
  }
  expect(connection.snapshot().grant).toMatchObject({
    agent: "second-agent",
    phase: "connected",
  });
  expect(connection.snapshot().error).toBeUndefined();
  await connection.revoke();
  expect(second.close).toHaveBeenCalledOnce();
});

it("answers only the displayed request after a newer one replaces it", async () => {
  const server = transport(),
    connect = vi.fn(async () => server),
    deny = vi.fn(async () => {});
  const connection = createExternalApps();
  connection.bind({ connect, deny });
  const displayed = request;
  const newer = { ...request, client: "Newer client", state: "B".repeat(43) };
  connection.open(displayed, "viewer");
  connection.open(newer, "viewer");
  expect(deny).toHaveBeenCalledOnce();
  await connection.approve(displayed, "test-agent");
  await connection.deny(displayed);
  expect(connect).not.toHaveBeenCalled();
  expect(deny).toHaveBeenCalledOnce();
  expect(connection.snapshot().pending?.request).toBe(newer);
  expect(connection.snapshot().error).toBeUndefined();
  await connection.approve(newer, "test-agent");
  expect(server.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ state: newer.state }),
  );
  await connection.approve(displayed, "other-agent");
  expect(connect).toHaveBeenCalledOnce();
  expect(server.close).not.toHaveBeenCalled();
  expect(connection.snapshot().grant).toMatchObject({
    client: "Newer client",
    agent: "test-agent",
    phase: "waiting",
  });
});

it("ends a live connection when the saved approval cannot be revoked", async () => {
  const agentPairing = {
    ...savedPairing,
    approval: { ...savedPairing.approval, scopes: ["agent"] as const },
  };
  const first = transport(),
    second = transport();
  const lifetimes: AbortSignal[] = [];
  const connect = vi
    .fn<Agents["connectExternal"]>()
    .mockImplementationOnce(async (_agent, signal) => {
      lifetimes.push(signal);
      return first;
    })
    .mockResolvedValueOnce(second);
  let saved = false;
  first.authorize.mockImplementationOnce(async () => {
    saved = true;
  });
  const revokeStarted = deferred<void>(),
    revoking = deferred<void>();
  let failRevoke = false;
  const connection = createExternalApps();
  connection.bind({
    connect,
    deny: async () => {},
    pairing: async (operation) => {
      if (operation === "revoke" && failRevoke) {
        revokeStarted.resolve();
        await revoking.promise;
        throw new Error("Saved approval write failed");
      }
      if (operation === "revoke") saved = false;
      return saved ? agentPairing : null;
    },
  });
  connection.open({ ...request, version: 2 }, "viewer");
  await approvePending(connection, "test-agent");
  expect(connection.snapshot().grant?.phase).toBe("waiting");
  expect(connection.snapshot().pairing).toEqual(agentPairing);

  failRevoke = true;
  const revoked = connection.revoke();
  try {
    await revokeStarted.promise;
    // Local access ends before the saved approval write settles.
    expect(lifetimes[0]?.aborted).toBe(true);
    expect(first.close).toHaveBeenCalledOnce();
    expect(connection.snapshot().grant).toEqual({
      client: agentPairing.approval.client,
      agent: agentPairing.approval.agent,
      phase: "ended",
    });
  } finally {
    revoking.resolve();
    await revoked;
  }
  expect(connection.snapshot().error).toContain("Cannot revoke");
  expect(connection.snapshot().pairing).toEqual(agentPairing);
  expect(connection.snapshot().grant).toEqual({
    client: agentPairing.approval.client,
    agent: agentPairing.approval.agent,
    phase: "ended",
  });

  failRevoke = false;
  connection.open({ ...request, version: 2, state: "B".repeat(43) }, "viewer");
  await approvePending(connection, "test-agent");
  expect(second.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ state: "B".repeat(43) }),
  );
  expect(connection.snapshot().grant?.phase).toBe("waiting");
  expect(connection.snapshot().error).toBeUndefined();
});
