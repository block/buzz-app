import { Component, type ReactNode } from "react";

// Identity, not just id/revision: disabling and re-enabling is a fresh installation.
const keys = new WeakMap<object, number>();
let next = 0;
export function contributionKey(entry: object) {
  let key = keys.get(entry);
  if (key === undefined) {
    key = ++next;
    keys.set(entry, key);
  }
  return key;
}
export class ContributionBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
