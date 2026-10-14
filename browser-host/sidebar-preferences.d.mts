import type {
  SidebarAssignmentIntent,
  SidebarGroups,
} from "../src/features/relay/sidebar-preferences";
import type { RelayEvent } from "../src/features/relay/events";

export function decodeSidebarPreferences(
  events: readonly RelayEvent[],
  secret: Uint8Array,
): import("../src/features/relay/sidebar-preferences").SidebarPreferences;
export function assertSidebarAssignmentIntent(
  intent: unknown,
): asserts intent is SidebarAssignmentIntent;
export function prepareSidebarAssignment(
  events: readonly RelayEvent[],
  intent: SidebarAssignmentIntent,
  secret: Uint8Array,
  now?: number,
): { groups: SidebarGroups; event?: RelayEvent };
export function mutateSidebarAssignment(
  intent: SidebarAssignmentIntent,
  secret: Uint8Array,
  readHead: () => Promise<readonly RelayEvent[]>,
  publish: (event: RelayEvent) => Promise<void>,
): Promise<SidebarGroups>;
export const SIDEBAR_REQUEST_BYTES: number;
export const SIDEBAR_UPLOAD_SLOTS: number;
export const SIDEBAR_UPLOAD_MS: number;
