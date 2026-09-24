import { finalizeEvent, getPublicKey } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
const secret = (n) =>
  Uint8Array.from({ length: 32 }, (_, i) =>
    i === 30 ? n >> 8 : i === 31 ? n & 255 : 0,
  );
export const identities = {};
const person = (id, name, n, owner) =>
  (identities[id] = {
    id,
    name,
    key: secret(n),
    pubkey: getPublicKey(secret(n)),
    ...(owner === undefined ? {} : { isAgent: true, owner }),
  });
person("viewer", "Alex", 1);
person("wes", "Wes", 2);
person("otherWes", "Wes", 3);
person("alex", "Alex", 4);
person("human", "Honey", 5);
person("human2", "Honey", 6);
person("mine", "Honey", 7, "viewer");
person("mine2", "Honey", 8, "viewer");
person("theirs", "Honey", 9, "wes");
person("theirs2", "Honey", 10, "wes");
person("otherOwner", "Honey", 11, "otherWes");
person("unknown", "Honey", 12, null);
person("unknown2", "Honey", 13, null);
person("literalOwner", "Wes’s Honey", 14);
person("literalAgent", "Honey (agent)", 15);
person("lower", "honey", 16);
person("padded", " Honey ", 17);
person("unique", "Juniper", 18, "wes");
person(
  "literalSuffix",
  `Honey · ${npubEncode(identities.mine.pubkey).slice(-4)}`,
  19,
);
// Find real signing keys with a shared last-four npub ending; no invalid synthetic pubkeys.
const tails = new Map();
for (let n = 20; n < 10000; n++) {
  const key = secret(n),
    pubkey = getPublicKey(key),
    tail = npubEncode(pubkey).slice(-4);
  if (tails.has(tail)) {
    const first = tails.get(tail);
    person("tail1", "Echo", first, "viewer");
    person("tail2", "Echo", n, "viewer");
    break;
  }
  tails.set(tail, n);
}
export const viewer = identities.viewer.pubkey;
export const relayKey = secret(20000),
  relayAuthor = getPublicKey(relayKey);
export const sign = (
  kind,
  tags,
  content = "",
  key = relayKey,
  time = Math.floor(Date.now() / 1000),
) => finalizeEvent({ kind, tags, content, created_at: time }, key);
export const profiles = () =>
  Object.values(identities).map((i) =>
    sign(
      0,
      i.owner
        ? [
            [
              "auth",
              identities[i.owner].pubkey,
              "demo-display-only",
              "0".repeat(128),
            ],
          ]
        : [],
      JSON.stringify({
        name: i.name,
        about: `Synthetic demo identity: ${i.id}. Not a real account.`,
        ...(i.isAgent ? { is_agent: true } : {}),
      }),
      i.key,
    ),
  );
export const cases = [
  ["unique", "01 Unique name", ["unique"], "Juniper stays plain"],
  [
    "viewer-human",
    "02 Viewer before other human",
    ["viewer", "alex"],
    "Alex; Alex with key qualifier",
  ],
  [
    "human-tie",
    "03 Equal human priority",
    ["human", "human2"],
    "Both Honey identities get key qualifiers",
  ],
  [
    "human-agents",
    "04 Human before agents",
    ["human", "mine", "theirs"],
    "Honey; Honey (agent); Wes’s Honey",
  ],
  [
    "mine-first",
    "05 Mine before other agents",
    ["mine", "theirs"],
    "Honey; Wes’s Honey",
  ],
  [
    "mine-tie",
    "06 My duplicate agents",
    ["mine", "mine2"],
    "Both Honey identities get key qualifiers",
  ],
  [
    "other-tie",
    "07 Same other owner",
    ["theirs", "theirs2"],
    "Both Wes’s Honey identities get key qualifiers",
  ],
  [
    "human-mine-tie",
    "08 Human plus my duplicates",
    ["human", "mine", "mine2"],
    "Honey; both Honey (agent) identities get key qualifiers",
  ],
  [
    "owner-tie",
    "09 Duplicate owner names",
    ["theirs", "otherOwner"],
    "Both Wes’s Honey identities get key qualifiers",
  ],
  [
    "owner-missing",
    "10 Missing owners",
    ["unknown", "unknown2"],
    "Both Honey identities get key qualifiers",
  ],
  [
    "readable-first",
    "11 Readable before key",
    ["unknown", "theirs"],
    "Honey; Wes’s Honey",
  ],
  [
    "literal-owner",
    "12 Literal possessive collision",
    ["mine", "theirs", "literalOwner"],
    "Literal Wes’s Honey wins; agent gets key qualifier",
  ],
  [
    "literal-agent",
    "13 Literal agent marker",
    ["human", "mine", "literalAgent"],
    "Literal Honey (agent) wins; agent gets key qualifier",
  ],
  [
    "tail-extension",
    "14 Shared key ending",
    ["tail1", "tail2"],
    "Echo key qualifiers extend beyond four characters",
  ],
  [
    "literal-suffix",
    "15 Literal suffix collision",
    ["mine", "mine2", "literalSuffix"],
    "Generated suffix extends; literal name stays plain",
  ],
  [
    "case-sensitive",
    "16 Case-sensitive names",
    ["human", "lower"],
    "Honey and honey stay distinct",
  ],
  [
    "trim",
    "17 Trimmed collision",
    ["human", "padded"],
    "Whitespace does not avoid collision",
  ],
  [
    "conflict-lab",
    "18 All conflicts",
    [
      "viewer",
      "alex",
      "human",
      "human2",
      "mine",
      "mine2",
      "theirs",
      "theirs2",
      "otherOwner",
      "unknown",
      "unknown2",
      "literalOwner",
      "literalAgent",
      "literalSuffix",
      "tail1",
      "tail2",
      "lower",
      "padded",
    ],
    "Mixed conflict stress scene",
  ],
  [
    "surfaces",
    "19 Surface tour",
    ["human", "mine", "theirs"],
    "Readable conflicts across surfaces",
  ],
  [
    "dm-conflicts",
    "20 Conflict DM",
    ["human", "mine", "theirs"],
    "Participant-scoped DM labels",
  ],
  [
    "session-demo",
    "21 Conflict session",
    ["mine", "theirs"],
    "Session selector uses library choice set",
  ],
];
export const channels = cases.map(([id, name, ids, description]) => ({
  id,
  name,
  ids: [
    ...new Set([
      "viewer",
      "wes",
      ...(id === "owner-tie" ? ["otherWes"] : []),
      ...ids,
    ]),
  ],
  description,
  type: id.startsWith("dm-")
    ? "dm"
    : id.startsWith("session-")
      ? "session"
      : "stream",
}));
export const records = [];
const start = Math.floor(Date.parse("2026-09-23T15:50:00Z") / 1000);
for (const channel of channels) {
  records.push(
    sign(
      39000,
      [
        ["d", channel.id],
        ["name", channel.name],
        ["t", channel.type === "dm" ? "dm" : "stream"],
        ...(channel.type === "dm" ? [["hidden"]] : []),
        ...(channel.type === "session"
          ? [["private"], ["about", "Buzz session (buzz.sessions/v1)"]]
          : []),
      ],
      "",
      relayKey,
      start,
    ),
  );
  records.push(
    sign(
      39002,
      [
        ["d", channel.id],
        ...channel.ids.map((id) => ["p", identities[id].pubkey]),
      ],
      "",
      relayKey,
      start,
    ),
  );
  for (const [j, id] of channel.ids.entries()) {
    if (
      ["wes", "otherWes"].includes(id) ||
      (id === "viewer" &&
        !["viewer-human", "conflict-lab"].includes(channel.id))
    )
      continue;
    const i = identities[id];
    records.push(
      sign(
        9,
        [["h", channel.id]],
        `${channel.description}.\nIdentity: ${id}${i.isAgent ? `; agent; owner: ${i.owner ?? "not supplied"}` : "; human"}.`,
        i.key,
        start + 10 + j,
      ),
    );
  }
}
export const root = sign(
  9,
  [["h", "surfaces"]],
  "Naming demo: thread, mentions, preview and profile. Select an avatar or open this thread.",
  identities.theirs.key,
  start + 100,
);
export const reply = sign(
  9,
  [
    ["h", "surfaces"],
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
  ],
  "A reply from your agent; the human still keeps Honey.",
  identities.mine.key,
  start + 101,
);
records.push(
  root,
  reply,
  sign(
    39005,
    [
      ["h", "surfaces"],
      ["e", root.id],
    ],
    JSON.stringify({
      reply_count: 1,
      last_reply_at: reply.created_at,
      participants: [identities.mine.pubkey, identities.theirs.pubkey],
    }),
    relayKey,
    start + 102,
  ),
);
records.push(
  sign(
    40099,
    [["h", "surfaces"]],
    JSON.stringify({
      type: "member_joined",
      actor: viewer,
      target: identities.theirs.pubkey,
    }),
    relayKey,
    start + 103,
  ),
);
records.push(
  sign(
    9,
    [
      ["h", "surfaces"],
      ["p", identities.mine.pubkey],
    ],
    "A sent mention: @Honey. A readable reference: @Wes.",
    identities.human.key,
    start + 104,
  ),
);
records.push(
  sign(
    9,
    [["h", "surfaces"]],
    `Preview: <buzz://message?channel=surfaces&id=${root.id}>`,
    identities.mine.key,
    start + 105,
  ),
);
export const library = {
  definitions: [{ id: "honey-template", name: "Honey template" }],
  identities: Object.values(identities)
    .filter((i) => i.isAgent)
    .map((i) => ({
      pubkey: i.pubkey,
      name: i.name,
      ...(i.id === "theirs" || i.id === "theirs2"
        ? { definitionId: "honey-template" }
        : {}),
    })),
};
export const publicData = () => ({
  viewer,
  identities: Object.fromEntries(
    Object.entries(identities).map(([id, { key, ...i }]) => [
      id,
      { ...i, npub: npubEncode(i.pubkey) },
    ]),
  ),
  channels,
  cases,
  root: root.id,
  reply: reply.id,
  media: media.id,
  oldSessionMessage: oldSessionMessage.id,
});

export const media = sign(
  9,
  [
    ["h", "surfaces"],
    [
      "imeta",
      "url https://names.demo.invalid/media/demo.svg",
      "m image/svg+xml",
      "alt Naming conflict illustration",
    ],
  ],
  "Media review with a disambiguated author.",
  identities.theirs.key,
  start + 106,
);
records.push(media);

const mediaReply = sign(
  9,
  [
    ["h", "surfaces"],
    ["e", media.id, "", "root"],
    ["e", media.id, "", "reply"],
  ],
  "A media comment with an owner-qualified author.",
  identities.theirs.key,
  start + 107,
);
records.push(
  mediaReply,
  sign(
    39005,
    [
      ["h", "surfaces"],
      ["e", media.id],
    ],
    JSON.stringify({
      reply_count: 1,
      last_reply_at: mediaReply.created_at,
      participants: [identities.theirs.pubkey],
    }),
    relayKey,
    start + 108,
  ),
);
export const oldSessionMessage = sign(
  9,
  [["h", "session-demo"]],
  "An older exact session target, outside the initial history window.",
  identities.theirs.key,
  start - 100,
);
records.push(oldSessionMessage);
const dmMessage = records.find(
  (e) =>
    e.kind === 9 &&
    e.pubkey === identities.theirs.pubkey &&
    e.tags.some((t) => t[0] === "h" && t[1] === "dm-conflicts"),
);
records.push(
  sign(
    9,
    [["h", "surfaces"]],
    `DM preview: <buzz://message?channel=dm-conflicts&id=${dmMessage.id}>`,
    identities.mine.key,
    start + 109,
  ),
);
