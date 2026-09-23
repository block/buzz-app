import { expect, it } from "vitest";
import { HashIcon, LockIcon } from "../../shared/design-system/icons/index";
import { channelIcon } from "./channel-icon";

it("uses a lock only for private channels", () => {
  expect(channelIcon({ private: true })).toBe(LockIcon);
  expect(channelIcon({})).toBe(HashIcon);
  expect(channelIcon(undefined)).toBe(HashIcon);
});
