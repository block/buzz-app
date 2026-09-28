import assert from "node:assert/strict";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools";

// Public test scalars only. This host never reads credentials or contacts a relay.
const key = (n) =>
  Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
export const viewer = getPublicKey(key(31));
const peer = getPublicKey(key(32));
const authority = getPublicKey(key(33));
export const community = "https://harbour.demo.invalid";
export const sign = (
  kind,
  tags,
  content,
  n = 33,
  time = Math.floor(Date.now() / 1000),
) => finalizeEvent({ kind, tags, content, created_at: time }, key(n));

export function createHost({ admitted = false, profile = false } = {}) {
  const state = {
    admitted,
    aliases: {},
    fault: "",
    calls: [],
    publications: [],
    signatures: [],
    profile: profile
      ? sign(
          0,
          [],
          JSON.stringify({
            name: "Alex Morgan",
            about: "Designing the harbour workspace",
            custom: "Keep this field",
          }),
          31,
        )
      : undefined,
    records: [
      sign(
        39000,
        [
          ["d", "launch"],
          ["name", "launch-planning"],
          ["t", "stream"],
        ],
        "",
      ),
      sign(
        39002,
        [
          ["d", "launch"],
          ["p", viewer],
          ["p", peer],
        ],
        "",
      ),
      sign(0, [], JSON.stringify({ name: "Sam Rivera" }), 32),
      sign(
        9,
        [["h", "launch"]],
        "Welcome, Alex. The launch checklist is ready for review.",
        32,
        Math.floor(Date.now() / 1000) - 120,
      ),
    ],
  };
  const matches = (e, f) =>
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f.ids || f.ids.includes(e.id)) &&
    (!f.authors || f.authors.includes(e.pubkey)) &&
    Object.entries(f)
      .filter(([k]) => k.startsWith("#"))
      .every(([k, values]) =>
        e.tags.some((t) => t[0] === k.slice(1) && values.includes(t[1])),
      );
  const query = (filters) => [
    ...new Map(
      filters
        .flatMap((f) =>
          [...state.records, ...(state.profile ? [state.profile] : [])]
            .filter((e) => matches(e, f))
            .sort(
              (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
            )
            .slice(0, f.limit ?? 100)
            .concat(
              f.include_aux
                ? [
                    sign(
                      39006,
                      [
                        ["h", f["#h"]?.[0] ?? ""],
                        ["d", `${f["#h"]?.[0]}:head`],
                      ],
                      JSON.stringify({ has_more: false, next_cursor: null }),
                    ),
                  ]
                : [],
            ),
        )
        .map((e) => [e.id, e]),
    ).values(),
  ];
  const response = (body, status = 200) => ({
    status,
    headers: {},
    body: JSON.stringify(body),
  });
  async function invoke(command, payload = {}) {
    state.calls.push(structuredClone({ command, ...payload }));
    if (command === "fixture_config") return { aliases: state.aliases };
    if (command === "identity_restore") return viewer;
    if (command === "relay_sign") {
      assert.equal(payload.community, community);
      assert.deepEqual(Object.keys(payload.event).sort(), [
        "content",
        "created_at",
        "kind",
        "tags",
      ]);
      state.signatures.push(payload.event.kind);
      return finalizeEvent(payload.event, key(31));
    }
    if (command === "agent_control_snapshot")
      return {
        agents: [],
        runtimeAvailable: false,
        importAvailable: false,
        runtimeMessage: "Recording fixture",
      };
    if (command === "deep_link_take") return [];
    if (command === "dock_permission") return "denied";
    if (
      [
        "deep_link_watch",
        "unread_indicator_set",
        "notification_subscribe",
      ].includes(command)
    )
      return null;
    if (command.startsWith("plugin:event|")) return 1;
    if (command.startsWith("plugin:window|")) return false;
    assert.equal(
      command,
      "relay_http",
      `Unsupported recording IPC: ${command}`,
    );
    assert.equal(payload.community, community);
    const body = payload.body ? JSON.parse(payload.body) : undefined;
    if (payload.path === "/")
      return response({ self: authority, name: "Harbour Studio" });
    if (payload.path === "/api/join-policy")
      return response({
        policy: {
          version: "studio-1",
          terms_markdown: "Respect your collaborators.",
          privacy_markdown: null,
          age_attestation_required: true,
        },
      });
    if (payload.path === "/api/invites/accept-policy") {
      assert.equal(body.age_confirmed, true);
      return response({ receipt: "fixture-policy-receipt" });
    }
    if (payload.path === "/api/invites/claim") {
      assert.equal(body.policy_receipt, "fixture-policy-receipt");
      state.admitted = true;
      if (state.fault === "claim")
        throw new Error(
          "Invite accepted, but the response was interrupted. Try again.",
        );
      return response({ status: "joined" });
    }
    if (payload.path === "/query") {
      if (!state.admitted)
        return response({ error: "membership required" }, 403);
      if (
        state.verificationGate &&
        profilesPublished() &&
        body.some((f) => f.kinds?.includes(0))
      ) {
        const gate = state.verificationGate;
        state.verificationGate = undefined;
        state.verificationStarted = true;
        await gate;
      }
      if (state.fault === "read" && body.some((f) => f.kinds?.includes(0)))
        throw new Error("Profile read unavailable. Your draft is retained.");
      if (state.fault === "offline")
        throw new Error("Community is offline. Try again when connected.");
      return response(query(body));
    }
    if (payload.path === "/events") {
      assert(verifyEvent(body));
      assert.equal(body.pubkey, viewer);
      state.publications.push(body);
      if (body.kind === 0) {
        if (state.fault === "missing") state.profile = undefined;
        else if (
          !state.profile ||
          body.created_at > state.profile.created_at ||
          (body.created_at === state.profile.created_at &&
            body.id < state.profile.id)
        )
          state.profile = body;
        if (state.fault === "profile")
          throw new Error(
            "Profile sent, but the response was interrupted. Try again.",
          );
        if (state.fault === "read-after") state.fault = "read";
      } else {
        if (!state.records.some((e) => e.id === body.id))
          state.records.push(body);
        if (state.fault === "send") {
          // Keep ordinary history stale until retry/readback, as in an uncertain receipt.
          state.records = state.records.filter((e) => e.id !== body.id);
          throw new Error("Delivery response interrupted");
        }
      }
      return response({ accepted: true, event_id: body.id });
    }
    throw new Error(`Unsupported recording route: ${payload.path}`);
  }
  const profilesPublished = () => state.publications.some((e) => e.kind === 0);
  async function install(page) {
    await page.exposeFunction("recordingInvoke", invoke);
    await page.addInitScript(() => {
      window.isTauri = true;
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          window.recordingSaveFault &&
          key.startsWith(window.recordingSaveFault)
        )
          throw new Error("Fixture storage is full");
        original.call(this, key, value);
      };
    });
    await page.routeWebSocket("wss://harbour.demo.invalid/", (socket) => {
      let authenticated = false;
      const subscriptions = new Map();
      state.socket = socket;
      state.subscriptions = subscriptions;
      socket.onMessage((raw) => {
        const [kind, id, ...filters] = JSON.parse(raw);
        if (kind === "AUTH") {
          assert(verifyEvent(id));
          assert.equal(id.pubkey, viewer);
          assert(
            id.tags.some(
              (t) => t[0] === "challenge" && t[1] === "recording-challenge",
            ),
          );
          authenticated = true;
          socket.send(JSON.stringify(["OK", id.id, true]));
        } else if (kind === "REQ") {
          assert(authenticated);
          subscriptions.set(id, filters);
          socket.send(JSON.stringify(["EOSE", id]));
        } else if (kind === "CLOSE") subscriptions.delete(id);
        else if (kind === "EVENT")
          socket.send(JSON.stringify(["OK", id.id, true]));
      });
      socket.send(JSON.stringify(["AUTH", "recording-challenge"]));
    });
    // No external HTTP, broker, accounts, or real communities can be reached.
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
    });
  }
  function live(content) {
    const event = sign(9, [["h", "launch"]], content, 32);
    state.records.push(event);
    let deliveries = 0;
    for (const [id, filters] of state.subscriptions ?? []) {
      if (filters.some((f) => matches(event, f))) {
        state.socket.send(JSON.stringify(["EVENT", id, event]));
        deliveries++;
      }
    }
    assert(deliveries > 0, "Expected an authenticated live subscription");
  }
  return { state, install, live };
}
