import {
  fixtureRelayUrl,
  fixtureAliases,
} from "../../../tests/relay-config.ts";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { assert, expect, it } from "vitest";
import { type Event, validateEvent, verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "../../../dev/relay-broker.mjs";
import { connectBrokerTransport } from "../relay/transport";
import { keypair } from "../relay/testing";

function isSignedEvent(value: unknown): value is Event {
  return (
    validateEvent(value) &&
    "id" in value &&
    typeof value.id === "string" &&
    "sig" in value &&
    typeof value.sig === "string"
  );
}

it("routes reads, profile publication, invite claims and delayed writes to their captured community", async () => {
  const identity = keypair(),
    relay = keypair();
  const calls: { url: string; body: unknown; auth: unknown }[] = [];
  let handler: RequestListener | undefined;
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    relayUrl: fixtureRelayUrl,
    communityAliases: fixtureAliases,
    identity: () => identity.secret,
    authority: async () => ({ relayAuthor: relay.pubkey }),
    upstreamFetch: async (input, init) => {
      const url = String(input);
      const body: unknown = JSON.parse(init?.body as string);
      const auth: unknown = JSON.parse(
        Buffer.from(
          String(
            (init?.headers as Record<string, string> | undefined)
              ?.Authorization,
          ).slice(6),
          "base64",
        ).toString(),
      );
      calls.push({ url, body, auth });
      if (url.endsWith("/events")) {
        if (!isSignedEvent(body))
          throw new Error("Expected a published signed event");
        return Response.json({ accepted: true, event_id: body.id });
      }
      if (url.endsWith("/claim")) return Response.json({ status: "joined" });
      if (url.endsWith("/accept-policy"))
        return Response.json({ receipt: "fixture-receipt" });
      return Response.json([]);
    },
  });
  await (plugin.configureServer as (s: ViteDevServer) => Promise<void>)({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb: RequestListener) {
        handler = cb;
      },
    },
  } as unknown as ViteDevServer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (id: string, route: string, body: unknown) =>
    fetch(`${base}/api/relay/${id}/${route}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  try {
    expect(calls).toHaveLength(0);
    const a = await connectBrokerTransport(base, undefined, "primary");
    assert.exists(a.writer);
    const signed = await a.writer.sign(
      {
        kind: 9,
        content: "fixture",
        created_at: Math.floor(Date.now() / 1000),
        tags: [["h", "same-channel"]],
      },
      new AbortController().signal,
    );
    const b = await connectBrokerTransport(base, undefined, "secondary");
    await b.query([{ kinds: [0], limit: 1 }]);
    await a.writer.publish(signed, new AbortController().signal);
    expect(calls[0]?.url).toBe("https://secondary.example/query");
    expect(calls[1]?.url).toBe("https://primary.example/events");
    const profile = await post("secondary", "profile", {
      name: "Community name",
      picture: "",
      existing: { about: "preserved" },
    });
    expect(profile.ok).toBe(true);
    const profileEvent = calls[2]?.body;
    if (!isSignedEvent(profileEvent))
      throw new Error("Expected a signed profile event");
    expect(profileEvent.kind).toBe(0);
    expect(JSON.parse(profileEvent.content)).toMatchObject({
      display_name: "Community name",
      about: "preserved",
    });
    expect(verifyEvent(profileEvent)).toBe(true);
    await post("secondary", "accept-policy", {
      code: "fixture",
      policy_version: "v1",
      age_confirmed: true,
    });
    await post("secondary", "claim", {
      code: "fixture",
      policy_receipt: "fixture-receipt",
    });
    const claim = calls[4]?.body;
    if (
      typeof claim !== "object" ||
      claim === null ||
      !("policy_receipt" in claim)
    )
      throw new Error("Expected an invite claim receipt");
    expect(claim.policy_receipt).toBe("fixture-receipt");
    for (const call of calls) {
      const auth = call.auth;
      if (!isSignedEvent(auth))
        throw new Error("Expected a signed authentication event");
      expect(verifyEvent(auth)).toBe(true);
      expect(auth.tags).toContainEqual(["u", call.url]);
    }
    expect(
      (await post("unknown", "profile", { name: "Rejected", picture: "" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("primary", "profile", {
          name: "Rejected",
          picture: "javascript:bad",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("primary", "sign", { kind: 0, content: "{}", tags: [] }))
        .status,
    ).toBe(400);
    expect(a.media("https://primary.example/media/a")).toContain(
      "/primary/media?",
    );
    expect(b.media("https://secondary.example/media/b")).toContain(
      "/secondary/media?",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
