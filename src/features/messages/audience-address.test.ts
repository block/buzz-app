import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { profileTarget } from "../profiles/target";
import { addressedMessage, viewerAudience } from "./audience-address";

const rivet = "b".repeat(64);
const bob = "c".repeat(64);
const row = (content: string, attachmentSeams?: number[]) =>
  ({
    content,
    mentions: [rivet, bob],
    ...(attachmentSeams ? { attachmentSeams } : {}),
  }) as unknown as ChannelMessage;
const at = (pubkey: string, name: string) => ({
  text: `@${name}`,
  target: profileTarget(pubkey),
});

it("takes every leading mention as a recipient and shifts seams past them", () => {
  const { recipients, body } = addressedMessage(
    row("@Rivet, @Bob: run it", [3, 15]),
    [at(rivet, "Rivet"), { text: ", " }, at(bob, "Bob"), { text: ": run it" }],
  );
  expect(recipients).toEqual([rivet, bob]);
  expect(body.content).toBe("run it");
  expect(body.attachmentSeams).toEqual([1]);
});

it("keeps the line break and indentation after a leading mention", () => {
  const { recipients, body } = addressedMessage(row("@Rivet\n    code"), [
    at(rivet, "Rivet"),
    { text: "\n    code" },
  ]);
  expect(recipients).toEqual([rivet]);
  expect(body.content).toBe("\n    code");
});

it("quiets an agent's message only when it names people and not the viewer", () => {
  const viewer = "a".repeat(64);
  const agent = "d".repeat(64);
  const agents = new Set([agent]);
  const message = (authorId: string, mentions: string[]) =>
    ({ authorId, mentions, content: "hi" }) as unknown as ChannelMessage;
  const audience = (row: ChannelMessage) =>
    viewerAudience(row, viewer, agents).audience;
  expect(audience(message(agent, [bob]))).toBe("agents");
  expect(audience(message(agent, [bob, viewer]))).toBeUndefined();
  expect(audience(message(agent, []))).toBeUndefined();
  expect(audience(message(agent, [agent]))).toBeUndefined();
  expect(audience(message(rivet, [bob]))).toBeUndefined();
  expect(audience(message(viewer, [bob]))).toBeUndefined();
});
