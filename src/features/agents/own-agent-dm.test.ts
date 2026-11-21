import { describe, expect, it } from "vitest";
import { ownAgentDm } from "./own-agent-dm";

describe("ownAgentDm", () => {
  const viewer = "v".repeat(64);
  const agent = "a".repeat(64);
  const dm = (members: string[], channelType = "dm") => ({
    channelType,
    members,
  });
  const choices = (choice?: { managed?: boolean; messageable?: boolean }) => ({
    selectable: choice
      ? [{ pubkey: agent, name: "Agent", ...choice }]
      : ([] as { pubkey: string }[]),
  });
  it.each([
    ["an owned local agent", { managed: true }, agent],
    ["an owned hosted agent", { managed: false, messageable: true }, agent],
    ["another owner's catalog agent", { managed: false }, undefined],
    ["an archived or deleting agent", undefined, undefined],
  ] as const)("in a DM with %s", (_label, choice, expected) => {
    expect(
      ownAgentDm(
        dm([viewer, agent]),
        viewer,
        choices(choice) as Parameters<typeof ownAgentDm>[2],
      ),
    ).toBe(expected);
  });
  it("refuses a group DM, a Solo chat, someone else's DM and no viewer", () => {
    const owned = choices({ managed: true }) as Parameters<
      typeof ownAgentDm
    >[2];
    expect(ownAgentDm(dm([viewer, agent, "c".repeat(64)]), viewer, owned)).toBe(
      undefined,
    );
    expect(ownAgentDm(dm([viewer, agent], "solo"), viewer, owned)).toBe(
      undefined,
    );
    expect(ownAgentDm(dm(["c".repeat(64), agent]), viewer, owned)).toBe(
      undefined,
    );
    expect(ownAgentDm(dm([viewer, agent]), undefined, owned)).toBe(undefined);
    expect(
      ownAgentDm({ ...dm([viewer, agent]), archived: true }, viewer, owned),
    ).toBe(undefined);
  });
});
