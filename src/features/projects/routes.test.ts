import { describe, expect, it } from "vitest";
import { buzzLinkTarget, parseBuzzLink } from "../navigation/buzz-links";
import { deepLinkStep } from "../navigation/deep-links";
import {
  entityHref,
  entityTabs,
  entityTarget,
  parseEntityRoute,
  type EntityRoute,
} from "./routes";

const owner = "ab".repeat(32),
  id = "cd".repeat(32);
const scope = {
  viewer: "ef".repeat(32),
  communityOrigin: "https://community.example",
};
const routes: EntityRoute[] = [
  { type: "repo", owner, dtag: "repo" },
  { type: "project", owner, dtag: "project" },
  { type: "pr", owner, dtag: "repo", id },
  { type: "issue", owner, dtag: "repo", id },
  ...entityTabs.flatMap(
    (tab) =>
      [
        { type: "repo", owner, dtag: "repo", tab },
        { type: "project", owner, dtag: "project", tab },
      ] as EntityRoute[],
  ),
  ...[40, 64].map((length) => ({
    type: "repo" as const,
    owner,
    dtag: "repo",
    tab: "commits" as const,
    commit: "a".repeat(length),
  })),
];
describe("entity destinations", () => {
  it.each(routes)("round-trips $type $tab through both ingresses", (route) => {
    const href = entityHref(route);
    expect(parseBuzzLink(href)).toEqual({ format: "entity", route });
    expect(parseEntityRoute(route)).toEqual(route);
    expect(buzzLinkTarget(href, scope)).toEqual(entityTarget(route, scope));
    expect(
      deepLinkStep(href, {
        viewer: scope.viewer,
        selected: scope.communityOrigin,
      }),
    ).toEqual({ open: entityTarget(route, scope) });
    expect(
      deepLinkStep(href, { viewer: scope.viewer, selected: null }),
    ).toEqual({ fail: "unavailable" });
  });
  it("normalizes hex and preserves repository casing and canonical commit syntax", () => {
    const href = `buzz://repo/?owner=${owner.toUpperCase()}&d=My-Repo&tab=commits&commit=${"A".repeat(40)}`;
    expect(parseBuzzLink(href)).toEqual({
      format: "entity",
      route: {
        type: "repo",
        owner,
        dtag: "My-Repo",
        tab: "commits",
        commit: "a".repeat(40),
      },
    });
    expect(entityHref({ type: "issue", owner, dtag: "repo", id })).toBe(
      `buzz://issue?id=${id}&owner=${owner}&d=repo`,
    );
  });
  it.each([
    `repo?owner=${owner}`,
    `repo?owner=no&d=repo`,
    `repo?owner=${owner}&d=..repo`,
    `repo?owner=${owner}&d=a..b`,
    `repo?owner=${owner}&d=has%20space`,
    `repo?owner=${owner}&d=repo&tab=overview`,
    `repo?owner=${owner}&d=repo&tab=files&commit=${id}`,
    `repo?owner=${owner}&d=repo&tab=commits&commit=short`,
    `repo?owner=${owner}&d=repo&owner=${owner}`,
    `repo?owner=${owner}&d=repo&relay=https://elsewhere.example`,
    `project?owner=${owner}&d=project&commit=${id}`,
    `issue?owner=${owner}&d=repo`,
    `pr?id=${id}&owner=${owner}&d=repo&tab=prs`,
    `repo/path?owner=${owner}&d=repo`,
    `repo?owner=${owner}&d=repo#frag`,
    `user@repo?owner=${owner}&d=repo`,
    `commit?h=${id}`,
  ])("rejects ambiguous or unsupported %s", (part) => {
    expect(parseBuzzLink(`buzz://${part}`)).toBeNull();
    expect(
      deepLinkStep(`buzz://${part}`, {
        viewer: scope.viewer,
        selected: scope.communityOrigin,
      }),
    ).toEqual({ fail: "invalid-target" });
  });
  it.each([
    null,
    [],
    {},
    { type: "[" },
    { type: "repo", owner, dtag: "repo", extra: "x" },
    { type: "repo", owner, dtag: "repo", tab: null },
  ])("rejects malformed page routes", (route) =>
    expect(parseEntityRoute(route)).toBeNull(),
  );
});
