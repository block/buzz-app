import { describe, expect, it } from "vitest";
import { keypair, signed } from "../relay/testing";
import {
  moveControl,
  moveState,
  controlTemplate,
  validateMoveChannels,
  type MoveControl,
  type ControlEvent,
  type MoveRequest,
} from "./protocol";
import type { ChannelSummary } from "../relay/contracts";
const alice = keypair(),
  bob = keypair(),
  stranger = keypair();
const move = "00000000-0000-4000-8000-000000000001";
const worker = "00000000-0000-4000-8000-000000000002";
const nonce = "00000000-0000-4000-8000-000000000003";
const request: MoveRequest = {
  type: "request",
  move,
  worker,
  target: "target",
  expires: 200,
  authors: [
    [alice.pubkey, alice.pubkey],
    [bob.pubkey, bob.pubkey],
  ],
};
function record(key: typeof alice, control: MoveControl, at = 100) {
  const event = signed(key, {
    ...controlTemplate("dm", control),
    created_at: at,
  });
  const parsed = moveControl(event);
  if (!parsed) throw new Error("Invalid fixture");
  return parsed;
}
const req = record(alice, request) as ControlEvent & { control: MoveRequest };
const response = (
  key: typeof alice,
  type: Exclude<MoveControl["type"], "request">,
  at = 101,
  extra = {},
) =>
  record(
    key,
    {
      type,
      move,
      request: req.event.id,
      worker,
      nonce,
      ...extra,
    } as MoveControl,
    at,
  );
const approve = (key: typeof alice, at = 101) =>
  response(key, "approve", at, { nonce: undefined });
const approvals = [approve(alice), approve(bob)];
describe("signed conversion decisions", () => {
  it("requires each human and ignores a stranger or another signed request", () => {
    const other = record(alice, {
      ...request,
      target: "elsewhere",
    }) as typeof req;
    expect(
      moveState(
        req,
        [
          approve(alice),
          approve(stranger),
          record(
            bob,
            { type: "approve", move, request: other.event.id, worker },
            102,
          ),
        ],
        103,
      ).status,
    ).toBe("pending");
    expect(moveState(req, approvals, 103).status).toBe("approved");
  });
  it("expires only while awaiting approvals", () => {
    expect(moveState(req, [approve(alice)], 200).status).toBe("expired");
    expect(moveState(req, approvals, 999).status).toBe("approved");
    expect(
      moveState(req, [approve(alice), approve(bob, 200)], 201).status,
    ).toBe("expired");
  });
  it("a late decline cannot revoke unanimous approval", () => {
    const early = record(
      bob,
      { type: "decline", move, request: req.event.id, reason: "No" },
      100,
    );
    const late = record(
      bob,
      { type: "decline", move, request: req.event.id, reason: "No" },
      102,
    );
    expect(moveState(req, [...approvals, early], 103).status).toBe("declined");
    expect(moveState(req, [...approvals, late], 103).status).toBe("approved");
  });
  it("lets only the initiator cancel before commit", () => {
    const cancellation = (key: typeof alice, at: number) =>
      record(key, { type: "cancel", move, request: req.event.id }, at);
    expect(
      moveState(req, [...approvals, cancellation(bob, 102)], 103).status,
    ).toBe("approved");
    expect(
      moveState(req, [...approvals, cancellation(alice, 102)], 103).status,
    ).toBe("cancelled");
  });
  it("requires readiness from the approving workers for the current nonce", () => {
    const probe = record(
      alice,
      { type: "probe", move, request: req.event.id, nonce },
      103,
    );
    const readyA = response(alice, "ready", 104);
    const wrong = response(bob, "ready", 104, {
      worker: "00000000-0000-4000-8000-000000000099",
    });
    expect(
      moveState(req, [...approvals, probe, readyA, wrong], 105).ready,
    ).toEqual([alice.pubkey]);
    expect(
      moveState(
        req,
        [...approvals, probe, readyA, response(bob, "ready", 119)],
        120,
      ).ready,
    ).toEqual([alice.pubkey]);
    expect(
      moveState(
        req,
        [...approvals, probe, readyA, response(bob, "ready", 105)],
        106,
      ).ready,
    ).toHaveLength(2);
  });
  it("rejects malformed coordination envelopes", () => {
    expect(
      moveControl(
        signed(alice, {
          ...controlTemplate("dm", request),
          tags: [
            ["h", "dm"],
            ["h", "other"],
            ["t", "buzz:dm-move:v1"],
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      moveControl(
        signed(alice, controlTemplate("dm", { type: "approve", move, worker })),
      ),
    ).toBeUndefined();
  });
});
it("permits public recipients to approve before joining; keeps private checks", () => {
  const dm: ChannelSummary = {
    id: "dm",
    name: "dm",
    channelType: "dm",
    members: [alice.pubkey, bob.pubkey],
  };
  const target: ChannelSummary = {
    id: "target",
    name: "Target",
    channelType: "stream",
    visibility: "public",
    readOnly: true,
  };
  expect(() =>
    validateMoveChannels(dm, target, dm.members ?? [], false),
  ).not.toThrow();
  expect(() => validateMoveChannels(dm, target, dm.members ?? [])).toThrow(
    "writable",
  );
  expect(() =>
    validateMoveChannels(
      dm,
      { ...target, visibility: "private", members: [alice.pubkey] },
      dm.members ?? [],
      false,
    ),
  ).toThrow("Everyone");
});

it("rejects existing destination guests before approval", () => {
  const dm: ChannelSummary = {
    id: "dm",
    name: "dm",
    channelType: "dm",
    members: [alice.pubkey, bob.pubkey],
  };
  const guest: ChannelSummary = {
    id: "target",
    name: "Target",
    channelType: "stream",
    visibility: "public",
    readOnly: true,
    viewerRole: "guest",
    members: [alice.pubkey, bob.pubkey],
  };
  expect(() =>
    validateMoveChannels(dm, guest, dm.members ?? [], false),
  ).toThrow("writable");
});
