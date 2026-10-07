import { expect, it } from "vitest";
import { decodeTeamFile, encodeTeam } from "./team-encoding";
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
  expect(() => decodeTeamFile(new Uint8Array(8 * 1024 * 1024 + 1))).toThrow(
    "size limit",
  );
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
