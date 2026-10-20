import type { SessionAction } from "../agents/service";

/** A compact/reset owns its conversation until it ends. Deliveries wait for
 * that boundary; interruption cancels this operation, never a later turn. */
export class SessionControls {
  private readonly changes = new Map<
    string,
    { action: SessionAction; controller: AbortController; done: Promise<void> }
  >();
  private readonly handoffs = new Map<string, number>();
  constructor(private readonly changed: () => void) {}
  active(key: string) {
    return this.changes.has(key) || this.handoffs.has(key);
  }
  compacting(key: string) {
    return this.changes.get(key)?.action === "compact";
  }
  async deliver(key: string, handoff: () => Promise<void>) {
    // Admission is synchronous when no action owns the session. Steering
    // handoffs can overlap; Compact/New cannot enter between them.
    while (this.changes.has(key))
      await this.changes.get(key)?.done.catch(() => undefined);
    this.handoffs.set(key, (this.handoffs.get(key) ?? 0) + 1);
    this.changed();
    try {
      await handoff();
    } finally {
      const count = (this.handoffs.get(key) ?? 1) - 1;
      if (count) this.handoffs.set(key, count);
      else this.handoffs.delete(key);
      this.changed();
    }
  }
  interrupt(key: string) {
    const change = this.changes.get(key);
    change?.controller.abort(new Error("Session action interrupted"));
    return !!change;
  }
  run(
    key: string,
    action: SessionAction,
    change: (signal: AbortSignal) => Promise<void>,
  ) {
    if (this.active(key))
      throw new Error("A session action is already running.");
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => change(controller.signal))
      .finally(() => {
        this.changes.delete(key);
        this.changed();
      });
    this.changes.set(key, { action, controller, done });
    this.changed();
    return done;
  }
}
