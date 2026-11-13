import { afterEach, expect, it, vi } from "vitest";
import { bundledPlugins } from "..";
import {
  communityIndexUrl,
  communityPluginsAccess,
  listingRepository,
} from "./config";

const published =
  "https://raw.githubusercontent.com/block/buzz-plugins/index/index.json";

afterEach(() => vi.unstubAllEnvs());

it("grants network access only to the index's origin and GitHub's API", () => {
  expect(communityPluginsAccess("")).toEqual({});
  expect(communityPluginsAccess(published)).toEqual({
    host: {
      networkOrigins: [
        "https://raw.githubusercontent.com",
        "https://api.github.com",
      ],
    },
  });
  expect(
    communityPluginsAccess("https://plugins.example:8443/v1/index.json?v=2"),
  ).toEqual({
    host: {
      networkOrigins: [
        "https://plugins.example:8443",
        "https://api.github.com",
      ],
    },
  });
  vi.stubEnv("VITE_BUZZ_COMMUNITY_PLUGIN_INDEX_URL", published);
  expect(communityIndexUrl()).toBe(published);
});

it("takes the listing repository from an index on raw.githubusercontent.com", () => {
  expect(listingRepository(published)).toBe("block/buzz-plugins");
  expect(listingRepository("https://plugins.example/index.json")).toBe(
    undefined,
  );
  expect(listingRepository("https://raw.githubusercontent.com/block")).toBe(
    undefined,
  );
  expect(listingRepository("")).toBe(undefined);
});

it("ships on by default with no access in a build without an index", () => {
  const plugin = bundledPlugins.find(
    ({ manifest }) => manifest.id === "buzz.community-plugins",
  );
  expect(plugin?.enabledByDefault).toBe(true);
  expect(plugin?.manifest.host).toBeUndefined();
});
