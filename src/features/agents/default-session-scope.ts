import { useSyncExternalStore } from "react";
import {
  sessionScope,
  type SessionScope,
} from "../agent-harness/session-scope";
import { readView, subscribeView, writeView } from "../../shared/view-state";

const DEVICE = "device";
const KEY = "agents:default-session-scope";

export const SESSION_SCOPE_GROUPS = [
  {
    label: "",
    options: [
      { value: "thread", label: "One session per thread" },
      { value: "channel", label: "One session per channel" },
      { value: "community", label: "One session per community" },
    ],
  },
];

export function readDefaultSessionScope(): SessionScope {
  return sessionScope(readView<unknown>(DEVICE, KEY, null));
}

export function writeDefaultSessionScope(scope: SessionScope): boolean {
  return writeView(DEVICE, KEY, scope);
}

export function useDefaultSessionScope() {
  return useSyncExternalStore(subscribe, readDefaultSessionScope);
}

function subscribe(listener: () => void) {
  return subscribeView(DEVICE, listener, KEY);
}
