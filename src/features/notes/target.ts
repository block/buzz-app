import type {
  JsonValue,
  NavigationScope,
  OpenTarget,
} from "../navigation/targets";
import { noteAddress, type NoteAddress } from "./model";

export function notePageRoute(
  value: JsonValue | undefined,
): NoteAddress | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== "channel,id"
  )
    return;
  try {
    return noteAddress(value);
  } catch {
    return;
  }
}
export function notePageTarget(
  address: NoteAddress,
  scope: NavigationScope,
): OpenTarget {
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.relay-notes",
    pageId: "notes",
    scope,
    route: { version: 1, params: { ...noteAddress(address) } },
  };
}
