import { expect, it, vi } from "vitest";
import {
  catalogTeamSnapshot,
  parsePublication,
  type TeamPublication,
} from "./catalog-protocol";
import type { AgentControl } from "./control";
import { controlFixture } from "./control-testing";
import { keypair, signed } from "../relay/testing";
import { importTeamMembers } from "./team-bundles";

// A listed team's members reach the shared importer with their canonical
// runtime names, which it maps onto this device's installed harnesses.
it("adds a catalog team's Claude, Hermes and Pi members through the shared importer", async () => {
  const installed = {
    claude: "/local/claude-agent-acp",
    hermes: "/local/hermes-acp",
    pi: "/local/buzz-pi-acp",
  };
  const listed = parsePublication(
    signed(keypair(), {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ["shared", "true"],
      ],
      content: JSON.stringify({
        v: 1,
        name: "Crew",
        members: Object.keys(installed).map((runtime, index) => ({
          member_key: `k${index}`,
          display_name: runtime,
          system_prompt: "Help.",
          acp_command: "buzz-acp",
          runtime,
        })),
      }),
      created_at: 1,
    }),
  ) as TeamPublication;

  const fixture = controlFixture();
  fixture.data.harnessOptions = Object.entries(installed).map(
    ([label, command]) => ({
      command,
      available: true,
      label,
      status: "ready",
      defaultArgs: [],
      providers: [],
    }),
  );
  const create = vi.fn<NonNullable<AgentControl["create"]>>(async () => ({
    ...fixture.agent,
  }));
  const control = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ data: fixture.data }),
    create,
  } as unknown as AgentControl;

  await importTeamMembers(
    control,
    catalogTeamSnapshot(listed),
    ["r0", "r1", "r2"],
    "https://relay.example",
    "ef".repeat(32),
    false,
    "team-copy",
  );
  expect(create.mock.calls.map((call) => call[3].harness?.command)).toEqual(
    Object.values(installed),
  );
});
