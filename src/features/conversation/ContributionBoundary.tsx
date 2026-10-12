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
  { children: ReactNode; fallback: ReactNode; resetIdentity?: unknown },
  { failed: boolean; resetIdentity?: unknown }
> {
  state = { failed: false, resetIdentity: this.props.resetIdentity };
  static getDerivedStateFromProps(
    props: ContributionBoundary["props"],
    state: ContributionBoundary["state"],
  ) {
    if (props.resetIdentity !== state.resetIdentity)
      return { failed: false, resetIdentity: props.resetIdentity };
    return null;
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
