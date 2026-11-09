import { afterEach, expect, it, vi } from "vitest";
import { communityRequest, publishProfile } from "./api";
import { CommunityRefused } from "./native-api";
import { ReadError } from "../relay/errors";
import { PublishRejected } from "../relay/outbox";
import { failureKind, refusalReason } from "../relay/user-copy";

afterEach(() => vi.unstubAllGlobals());

it("registers an unvisited destination before its scoped read, without a session", async () => {
  let release!: () => void;
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/relay/register") {
      expect(JSON.parse(init?.body as string)).toEqual({
        url: "https://unvisited.example",
      });
      await registered;
      return Response.json({});
    }
    expect(url).toBe(
      "/api/relay/https%3A%2F%2Funvisited.example/agent-inventory",
    );
    expect(init?.body).toBe("{}");
    return Response.json({ identities: ["ab".repeat(32)] });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = communityRequest(
    "https://unvisited.example",
    "agent-inventory",
    {},
  );
  try {
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await expect(result).resolves.toEqual({ identities: ["ab".repeat(32)] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(
    fetcher.mock.calls[1]?.[1]?.signal,
  );
});

it("does not read after registration failure and registers again on retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: "Destination rejected" }, { status: 400 }),
    )
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ identities: [] }));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    communityRequest("https://unvisited.example", "agent-inventory", {}),
  ).rejects.toThrow("Destination rejected");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    communityRequest("https://unvisited.example", "agent-inventory", {}),
  ).resolves.toEqual({ identities: [] });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/relay/register",
    "/api/relay/register",
    "/api/relay/https%3A%2F%2Funvisited.example/agent-inventory",
  ]);
});

it("does not read when cancelled during registration", async () => {
  const cancel = new AbortController();
  const fetcher = vi.fn(async () => {
    cancel.abort();
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    communityRequest(
      "https://unvisited.example",
      "agent-inventory",
      {},
      cancel.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([408, 429, 500, 502, 503])(
  "preserves retryable HTTP %s and its broker message",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/register")
          ? Response.json({})
          : Response.json({ error: "Relay unavailable" }, { status }),
      ),
    );
    await expect(
      communityRequest("https://unvisited.example", "info"),
    ).rejects.toMatchObject({
      name: "ReadError",
      kind: "unavailable",
      status,
      message: "Relay unavailable",
    });
  },
);

function answer(status: number, body: BodyInit | null, type?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/register")
        ? Response.json({})
        : new Response(body, {
            status,
            ...(type ? { headers: { "Content-Type": type } } : {}),
          }),
    ),
  );
}

it.each([
  [502, "<html><body>Bad gateway</body></html>", "text/html"],
  [500, "", undefined],
  [503, "upstream connect error", "text/plain"],
])(
  "checks the status before parsing: a non-JSON %s answer is a typed failure, not a parser error",
  async (status, body, type) => {
    answer(status, body, type);
    const error = await communityRequest(
      "https://unvisited.example",
      "profile",
      {},
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ReadError);
    expect(error).toMatchObject({
      kind: "unavailable",
      status,
      message: `Community request failed (${status})`,
    });
    expect(error).not.toBeInstanceOf(SyntaxError);
  },
);

it("carries a refusal's status and the community's own reason without a parser error", async () => {
  answer(
    403,
    JSON.stringify({ error: "restricted: you are timed out until 1794000000" }),
    "application/json",
  );
  const error = await communityRequest(
    "https://unvisited.example",
    "profile",
    {},
  ).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(CommunityRefused);
  expect(error).toMatchObject({
    status: 403,
    reason: "restricted: you are timed out until 1794000000",
  });
  expect(failureKind(error)).toBe("refused");
  expect(refusalReason(error)).toBe("You’re timed out in this community.");
});

it("keeps a 403 without a usable body a refusal with no reason", async () => {
  answer(403, "<html>Forbidden</html>", "text/html");
  const error = await communityRequest(
    "https://unvisited.example",
    "profile",
    {},
  ).catch((reason: unknown) => reason);
  expect(error).toMatchObject({
    status: 403,
    message: "Community request failed (403)",
  });
  expect(error).not.toHaveProperty("reason", expect.any(String));
  expect(failureKind(error)).toBe("refused");
  expect(refusalReason(error)).toBeUndefined();
});

it("reports a successful answer that is not JSON as an invalid response", async () => {
  answer(200, "<html>ok</html>", "text/html");
  const error = await communityRequest(
    "https://unvisited.example",
    "profile",
    {},
  ).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ReadError);
  expect(error).toMatchObject({
    kind: "invalid-response",
    message: "Invalid community response",
  });
});

it("types a relay OK false as refused and any other missing receipt as unconfirmed", async () => {
  const profile = { name: "Ada", picture: "" };
  const reply = (receipt: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(url.endsWith("/register") ? {} : receipt),
      ),
    );
  reply({
    accepted: false,
    event_id: "",
    message: "restricted: you are timed out until 1794000000",
  });
  const refused = await publishProfile(
    "https://unvisited.example",
    profile,
    {},
  ).catch((reason: unknown) => reason);
  expect(refused).toBeInstanceOf(PublishRejected);
  expect(failureKind(refused)).toBe("refused");
  expect(refusalReason(refused)).toBe("You’re timed out in this community.");
  for (const receipt of [
    { accepted: true },
    { accepted: false, event_id: "" },
  ]) {
    reply(receipt);
    const unconfirmed = await publishProfile(
      "https://unvisited.example",
      profile,
      {},
    ).catch((reason: unknown) => reason);
    expect(unconfirmed).toMatchObject({
      name: "ReadError",
      kind: "invalid-response",
      message: "Profile publication was not confirmed",
    });
  }
  reply({ accepted: true, event_id: "e".repeat(64) });
  await expect(
    publishProfile("https://unvisited.example", profile, {}),
  ).resolves.toBeUndefined();
});
