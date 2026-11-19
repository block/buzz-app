import { expect, it } from "vitest";
import { parseManagedProfile } from "./managed-profile";

const valid = {
  version: 1,
  source_label: "Directory",
  source_url: "https://example.org/people/alice",
  fields: [{ key: "team", section: "team", label: "Team", value: "Design" }],
};
it("accepts bounded directory fields and rejects unsafe links and malformed snapshots", () => {
  expect(parseManagedProfile(JSON.stringify(valid))).toEqual(valid);
  for (const change of [
    { version: 2 },
    { source_url: "javascript:alert(1)" },
    { source_url: "https://user:pass@example.org" },
    { fields: [...valid.fields, ...valid.fields] },
    { fields: [{ ...valid.fields[0], value: "x".repeat(513) }] },
    { fields: [{ ...valid.fields[0], section: "unknown" }] },
    { picture: "http://example.org/photo.png" },
    { city: "London\n" },
  ])
    expect(
      parseManagedProfile(JSON.stringify({ ...valid, ...change })),
    ).toBeUndefined();
  expect(parseManagedProfile(" ".repeat(16385))).toBeUndefined();
});

it("accepts bounded coordinates and rejects malformed locations", () => {
  expect(
    parseManagedProfile(
      JSON.stringify({ ...valid, coordinates: { latitude: 0, longitude: 0 } }),
    )?.coordinates,
  ).toEqual({ latitude: 0, longitude: 0 });
  for (const coordinates of [
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
    { latitude: "10", longitude: 0 },
    {},
    [],
  ]) {
    expect(
      parseManagedProfile(JSON.stringify({ ...valid, coordinates })),
    ).toBeUndefined();
  }
});
