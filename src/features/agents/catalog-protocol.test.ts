import { describe, expect, it } from "vitest";
import type { RelayEvent } from "../relay/events.ts";
import {
  agentCatalogContent,
  catalogCreatedAt,
  catalogHeads,
  catalogTemplate,
  memberKey,
  parsePublication,
  teamCatalogContent,
  visibleText,
} from "./catalog-protocol.ts";
import { controlFixture } from "./control-testing.ts";
import type { AgentView } from "./control.ts";

const owner = "cd".repeat(32);
function agent(overrides: Partial<AgentView> = {}): AgentView {
  return { ...controlFixture().agent, ...overrides };
}
let serial = 0;
function event(
  kind: number,
  tags: string[][],
  content: string,
  created_at = 100,
  id = (serial++).toString(16).padStart(64, "0"),
) {
  return {
    id,
    pubkey: owner,
    kind,
    tags,
    content,
    created_at,
    sig: "",
  } as unknown as RelayEvent;
}

describe("agent projection", () => {
  it("emits only portable public fields in wire order", () => {
    const content = agentCatalogContent(
      agent({ respondTo: "allowlist", picture: "data:image/png;base64,AA" }),
    );
    expect(content).toBe(
      JSON.stringify({
        display_name: "Fixture agent",
        system_prompt: "Help with the project.",
        acp_command: "buzz-acp",
        model: "fixture-model",
        provider: "fixture-provider",
        respond_to: "owner-only",
        session_policy: "channel",
      }),
    );
    for (const secret of [
      "EXAMPLE_TOKEN",
      "/fixture",
      "--literal",
      "workspace",
    ])
      expect(content).not.toContain(secret);
  });

  it("omits a machine-local transport that has no portable alias", () => {
    const body = JSON.parse(
      agentCatalogContent(agent({ acpCommand: "/opt/custom-acp" })),
    );
    expect(body).not.toHaveProperty("acp_command");
  });

  it("refuses concealed characters before anything is signed", () => {
    expect(() =>
      agentCatalogContent(agent({ systemPrompt: "safe\u202Eevil" })),
    ).toThrow("prohibited invisible or formatting characters");
    expect(visibleText("line\n\ttab 👩‍💻", true)).toBe(true);
    expect(visibleText("a\u200Bb", true)).toBe(false);
  });
});

describe("team projection", () => {
  const member = agent({ pubkey: owner, sessionPolicy: "thread" });
  it("embeds opaque member keys and omits the default session policy", async () => {
    const body = JSON.parse(
      await teamCatalogContent({ id: "t1", name: "Crew", agents: [owner] }, [
        member,
      ]),
    );
    expect(body.v).toBe(1);
    expect(body.members[0].member_key).toBe(await memberKey(owner));
    expect(body.members[0].member_key).not.toContain(owner);
    expect(body.members[0].session_policy).toBe("thread");
    const plain = JSON.parse(
      await teamCatalogContent({ id: "t1", name: "Crew", agents: [owner] }, [
        { ...member, sessionPolicy: null },
      ]),
    );
    expect(plain.members[0]).not.toHaveProperty("session_policy");
  });

  it("fails rather than publishing a partial team", async () => {
    await expect(
      teamCatalogContent(
        { id: "t1", name: "Crew", agents: ["ef".repeat(32)] },
        [member],
      ),
    ).rejects.toThrow("not found");
    await expect(
      teamCatalogContent(
        { id: "t1", name: "Crew", agents: Array(65).fill(owner) },
        [member],
      ),
    ).rejects.toThrow("65 members");
  });
});

describe("catalog reads", () => {
  const body = agentCatalogContent(agent());
  const shared = (created: number) =>
    event(
      30175,
      [
        ["d", owner],
        ["shared", "true"],
      ],
      body,
      created,
    );

  it("lets a newer unshared head retract older shared versions", () => {
    const unshared = event(30175, [["d", owner]], body, 200);
    const [head] = catalogHeads([shared(100), unshared]).values();
    expect(head).toBe(unshared);
    expect(head && parsePublication(head)).toBeUndefined();
  });

  it("breaks timestamp ties by the lowest id", () => {
    const low = event(30175, [["d", owner]], body, 100, "0".repeat(64));
    const high = event(
      30175,
      [
        ["d", owner],
        ["shared", "true"],
      ],
      body,
      100,
      "f".repeat(64),
    );
    expect([...catalogHeads([high, low]).values()]).toEqual([low]);
  });

  it("rejects malformed visibility and nonportable transports", () => {
    expect(
      parsePublication(
        event(
          30175,
          [
            ["d", owner],
            ["shared", "true", "x"],
          ],
          body,
        ),
      ),
    ).toBeUndefined();
    const custom = JSON.stringify({
      display_name: "X",
      acp_command: "/bin/sh",
    });
    expect(
      parsePublication(
        event(
          30175,
          [
            ["d", owner],
            ["shared", "true"],
          ],
          custom,
        ),
      ),
    ).toBeUndefined();
  });

  it("round-trips agents and teams into display-only records", async () => {
    expect(parsePublication(shared(100))).toMatchObject({
      kind: 30175,
      owner,
      agent: { displayName: "Fixture agent", respondTo: "owner-only" },
    });
    const team = await teamCatalogContent(
      { id: "t1", name: "Crew", agents: [owner] },
      [agent({ pubkey: owner })],
    );
    const parsed = parsePublication(
      event(
        30178,
        [
          ["d", "t1"],
          ["shared", "true"],
        ],
        team,
      ),
    );
    expect(parsed).toMatchObject({
      kind: 30178,
      name: "Crew",
      members: [
        { memberKey: await memberKey(owner), sessionPolicy: "channel" },
      ],
    });
  });
});

describe("catalog writes", () => {
  it("builds the owner-to-self envelope", () => {
    expect(catalogTemplate(30178, "t1", "{}", true).tags).toEqual([
      ["d", "t1"],
      ["shared", "true"],
    ]);
    expect(catalogTemplate(30178, "t1", "{}", false).tags).toEqual([
      ["d", "t1"],
    ]);
  });

  it("supersedes a future-dated head", () => {
    expect(catalogCreatedAt(50, { created_at: 90 })).toBe(91);
    expect(catalogCreatedAt(50)).toBe(50);
  });
});
