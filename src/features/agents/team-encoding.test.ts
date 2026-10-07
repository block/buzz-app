import { expect, it } from "vitest";
import {
  decodeTeamFile,
  encodeTeam,
  MAX_TEAM_SNAPSHOT_JSON_BYTES,
  MAX_TEAM_SNAPSHOT_PNG_BYTES,
} from "./team-encoding";
import type { TeamSnapshot } from "./team-bundles";
const snapshot: TeamSnapshot = {
  format: "buzz-team-snapshot",
  version: 1,
  team: { name: "Fixture 🛠", instructions: "TEAM_MARKER" },
  members: [
    {
      format: "buzz-agent-snapshot",
      version: 1,
      definition: {
        name: "Fixture",
        systemPrompt: "INDIVIDUAL_MARKER",
        runtime: "buzz-agent",
      },
      profile: { displayName: "Fixture" },
      memory: { level: "none", entries: [] },
    },
  ],
};
for (const format of ["json", "png"] as const) {
  it(`round-trips portable ${format} with unicode and separate prompts`, async () => {
    const bytes = new Uint8Array(
      await encodeTeam(snapshot, format).arrayBuffer(),
    );
    expect(JSON.parse(decodeTeamFile(bytes))).toEqual(snapshot);
  });
}
it("rejects corrupted embedded PNG manifest", async () => {
  const bytes = new Uint8Array(await encodeTeam(snapshot, "png").arrayBuffer());
  const offset = new TextDecoder().decode(bytes).indexOf("buzz_team_snapshot");
  bytes[offset + 20] = (bytes[offset + 20] ?? 0) ^ 1;
  expect(() => decodeTeamFile(bytes)).toThrow("checksum");
});
it("rejects oversized JSON before parsing", () => {
  expect(() =>
    decodeTeamFile(new Uint8Array(MAX_TEAM_SNAPSHOT_JSON_BYTES + 1)),
  ).toThrow("size limit");
});
it("does not mistake an ordinary PNG for a team", async () => {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAaX1ZFcAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  expect(() => decodeTeamFile(bytes)).toThrow("buzz_team_snapshot");
});

it("accepts JSON at the complete-file limit and rejects PNG above its own limit", () => {
  const json = new TextEncoder().encode(
    " ".repeat(MAX_TEAM_SNAPSHOT_JSON_BYTES),
  );
  expect(decodeTeamFile(json).length).toBe(MAX_TEAM_SNAPSHOT_JSON_BYTES);
  const png = new Uint8Array(MAX_TEAM_SNAPSHOT_PNG_BYTES + 1);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(() => decodeTeamFile(png)).toThrow("size limit");
});
for (const format of ["json", "png"] as const) {
  it(`an export at the JSON limit remains importable as ${format}`, async () => {
    const empty = { ...snapshot, team: { ...snapshot.team, instructions: "" } };
    const overhead = new TextEncoder().encode(
      JSON.stringify(empty, null, 2),
    ).length;
    const atLimit = {
      ...empty,
      team: {
        ...empty.team,
        instructions: "x".repeat(MAX_TEAM_SNAPSHOT_JSON_BYTES - overhead),
      },
    };
    const exportFile = encodeTeam(atLimit, format);
    expect(exportFile.size).toBeLessThanOrEqual(
      format === "json"
        ? MAX_TEAM_SNAPSHOT_JSON_BYTES
        : MAX_TEAM_SNAPSHOT_PNG_BYTES,
    );
    expect(
      JSON.parse(
        decodeTeamFile(new Uint8Array(await exportFile.arrayBuffer())),
      ),
    ).toEqual(atLimit);
    const over = {
      ...atLimit,
      team: { ...atLimit.team, instructions: `${atLimit.team.instructions}x` },
    };
    expect(() => encodeTeam(over, format)).toThrow("size limit");
  });
}
