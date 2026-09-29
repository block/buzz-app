import { expect, it } from "vitest";
import {
  activityTarget,
  activitySelection,
  profileActivityTarget,
} from "./activity-target";
const agent = "a".repeat(64);
it("round-trips an exact agent and optional channel without guessing a thread", () => {
  expect(activitySelection(activityTarget(agent))).toEqual({ agent });
  expect(activitySelection(activityTarget(agent, "a/b & c"))).toEqual({
    agent,
    channelId: "a/b & c",
  });
});
it("rejects other targets, ambiguous keys and malformed selection", () => {
  for (const target of [
    "",
    "nostr:npub1abc",
    activityTarget("Carl", "alpha"),
    `${activityTarget(agent)}&agent=${agent}`,
    `${activityTarget(agent)}&channel=`,
    `${activityTarget(agent)}&channel=a&channel=b`,
    `${activityTarget(agent)}#fragment`,
    `${activityTarget(agent)}&thread=one`,
    activityTarget(agent, "x".repeat(257)),
  ])
    expect(activitySelection(target)).toBeUndefined();
});
it("carries exact response identity with its required channel and rejects ambiguous response scope", () => {
  const message = "b".repeat(64);
  expect(activitySelection(activityTarget(agent, "alpha", message))).toEqual({
    agent,
    channelId: "alpha",
    messageId: message,
  });
  for (const value of [
    activityTarget(agent, undefined, message),
    activityTarget(agent, "alpha", "bad"),
    `${activityTarget(agent, "alpha", message)}&message=${message}`,
  ])
    expect(activitySelection(value)).toBeUndefined();
});
it("preserves request selection without accepting mixed or malformed scopes", () => {
  const requestId = "c".repeat(64);
  expect(
    activitySelection(activityTarget(agent, "alpha", undefined, requestId)),
  ).toEqual({ agent, channelId: "alpha", requestId });
  for (const target of [
    activityTarget(agent, undefined, undefined, requestId),
    activityTarget(agent, "alpha", "b".repeat(64), requestId),
    activityTarget(agent, "alpha", undefined, "bad"),
    `${activityTarget(agent, "alpha", undefined, requestId)}&request=${requestId}`,
  ])
    expect(activitySelection(target)).toBeUndefined();
});

it("locks profile presentation without accepting reply/request or ambiguous modes", () => {
  expect(activitySelection(profileActivityTarget(agent, "alpha"))).toEqual({
    agent,
    channelId: "alpha",
    view: "profile",
  });
  expect(activitySelection(profileActivityTarget(agent))).toEqual({
    agent,
    view: "profile",
  });
  for (const target of [
    `${profileActivityTarget(agent)}&view=profile`,
    `${activityTarget(agent)}&view=other`,
    `${activityTarget(agent)}&view=`,
    `${profileActivityTarget(agent, "alpha")}&message=${"b".repeat(64)}`,
    `${profileActivityTarget(agent, "alpha")}&request=${"b".repeat(64)}`,
  ])
    expect(activitySelection(target)).toBeUndefined();
});

it("round-trips explicit thread scope without mixing request, response or profile scopes", () => {
  const root = "d".repeat(64);
  const target = activityTarget(agent, "alpha", undefined, undefined, root);
  expect(activitySelection(target)).toEqual({
    agent,
    channelId: "alpha",
    threadRootId: root,
  });
  for (const bad of [
    `${target}&message=${root}`,
    `${target}&view=profile`,
    `${target}&thread=${root}`,
    activityTarget(agent, undefined, undefined, undefined, root),
  ])
    expect(activitySelection(bad)).toBeUndefined();
});

it("allows an explicit request within its loaded thread without accepting response/profile mixtures", () => {
  const request = "e".repeat(64),
    root = "f".repeat(64);
  expect(
    activitySelection(activityTarget(agent, "alpha", undefined, request, root)),
  ).toEqual({
    agent,
    channelId: "alpha",
    requestId: request,
    threadRootId: root,
  });
});
