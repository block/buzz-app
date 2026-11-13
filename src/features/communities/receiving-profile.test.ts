import { expect, it } from "vitest";
import { keypair, signed } from "../relay/testing";
import { receivingProfileTemplate } from "./receiving-profile";
import { TEST_RECEIVING_ADDRESS } from "./receiving-profile-fixture";

it("changes only the receiving fields of the viewer's signed profile, preserving tags and other metadata", () => {
  const viewer = keypair();
  const metadata = {
    name: "Sam",
    display_name: "Different display",
    about: "Keep",
    picture: "",
    nip05: "sam@example.test",
    custom: { keep: true },
    lud06: "old",
  };
  const profile = signed(viewer, {
    kind: 0,
    tags: [["custom", "keep"]],
    content: JSON.stringify(metadata),
    created_at: Math.floor(Date.now() / 1000),
  });
  const template = receivingProfileTemplate(
    { address: ` ${TEST_RECEIVING_ADDRESS} `, profile },
    viewer.pubkey,
  );
  expect(JSON.parse(template.content)).toEqual({
    ...metadata,
    lud06: undefined,
    lud16: TEST_RECEIVING_ADDRESS,
  });
  expect(template.tags).toEqual(profile.tags);
  expect(template.kind).toBe(0);
  expect(template.created_at).toBeGreaterThan(profile.created_at);
});

it("rejects another author, forged metadata, invalid addresses, and arbitrary fields", () => {
  const viewer = keypair();
  const profile = signed(viewer, {
    kind: 0,
    tags: [],
    content: JSON.stringify({ name: "Sam" }),
  });
  for (const input of [
    { profile },
    { address: TEST_RECEIVING_ADDRESS, profile: { ...profile, content: "{}" } },
    { address: TEST_RECEIVING_ADDRESS, profile, content: "{}" },
    { address: 5, profile },
    { address: "https://example.invalid/", profile },
  ])
    expect(() => receivingProfileTemplate(input, viewer.pubkey)).toThrow();
  expect(() =>
    receivingProfileTemplate(
      { address: TEST_RECEIVING_ADDRESS, profile },
      keypair().pubkey,
    ),
  ).toThrow();
});

it("clears both receiving fields without changing other metadata or tags", () => {
  const viewer = keypair();
  const profile = signed(viewer, {
    kind: 0,
    tags: [["keep", "tag"]],
    content: JSON.stringify({
      name: "Sam",
      custom: { keep: true },
      lud16: TEST_RECEIVING_ADDRESS,
      lud06: "legacy",
    }),
  });
  const template = receivingProfileTemplate(
    { address: null, profile },
    viewer.pubkey,
  );
  expect(JSON.parse(template.content)).toEqual({
    name: "Sam",
    custom: { keep: true },
  });
  expect(template.tags).toEqual(profile.tags);
  expect(template.created_at).toBeGreaterThan(profile.created_at);
});

it.each(["null", "[]", '"text"', "42", "true"])(
  "keeps receiving updates strict for non-object metadata %s",
  (content) => {
    const viewer = keypair();
    const profile = signed(viewer, { kind: 0, tags: [], content });
    for (const address of [TEST_RECEIVING_ADDRESS, null])
      expect(() =>
        receivingProfileTemplate({ address, profile }, viewer.pubkey),
      ).toThrow("Invalid profile metadata");
  },
);
