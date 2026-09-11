import { parseOpenTarget, targetKey, type OpenTarget } from "./targets";
import type { NavigationEntry, NavigationHistory } from "./history";

export type OpenFailure =
  | "invalid-target"
  | "unavailable"
  | "denied"
  | "not-found"
  | "timeout"
  | "host-error";
export type OpenResult = Readonly<
  | { status: "opened" }
  | { status: "cancelled" | "superseded" }
  | { status: "failed"; reason: OpenFailure }
>;
export type OpenAttempt = Readonly<{
  id: string;
  entry: NavigationEntry;
  signal: AbortSignal;
}>;
export type NavigationSnapshot = Readonly<{
  entry: NavigationEntry;
  attempt: OpenAttempt;
  status: "opening" | OpenResult["status"];
  reason?: OpenFailure;
  canGoBack: boolean;
  canGoForward: boolean;
}>;
export type Navigation = Readonly<{
  snapshot(): NavigationSnapshot;
  subscribe(listener: () => void): () => void;
  open(
    target: OpenTarget,
    options?: { replace?: boolean },
  ): Promise<OpenResult>;
  back(): void;
  forward(): void;
  retry(): Promise<OpenResult>;
}>;

/** The host alone receives completion/cancellation authority. Plugins get Navigation. */
export function createNavigationController(
  history: NavigationHistory,
  timeoutMs = 15_000,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new Error("Invalid open timeout");
  type Operation = {
    attempt: OpenAttempt;
    controller: AbortController;
    promise: Promise<OpenResult>;
    resolve: (result: OpenResult) => void;
    pending: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  let disposed = false;
  let active: Operation;
  let snapshot: NavigationSnapshot;
  const listeners = new Set<() => void>();
  // Commit state and capture each caller's result before invoking external code.
  // Reentrant opens run against committed state and own their own result; deferred
  // abort/notification effects never resume a half-written state transition.
  let depth = 0;
  let draining = false;
  const effects: (() => void)[] = [];
  function transaction<T>(run: () => T): T {
    depth++;
    try {
      return run();
    } finally {
      depth--;
      if (!depth && !draining) {
        draining = true;
        try {
          while (effects.length) effects.shift()?.();
        } finally {
          draining = false;
        }
      }
    }
  }
  const emit = () =>
    effects.push(() => {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          console.error("Navigation observer failed");
        }
      }
    });
  function settle(operation: Operation, result: OpenResult) {
    if (!operation.pending) return;
    operation.pending = false;
    clearTimeout(operation.timer);
    operation.resolve(result);
  }
  function finish(operation: Operation, result: OpenResult) {
    if (operation !== active || !operation.pending) return;
    settle(operation, result);
    snapshot = Object.freeze({
      ...snapshot,
      status: result.status,
      ...(result.status === "failed" ? { reason: result.reason } : {}),
    });
    if (result.status !== "opened")
      effects.push(() => operation.controller.abort());
    emit();
  }
  function start(): Promise<OpenResult> {
    if (disposed) return Promise.resolve({ status: "cancelled" });
    const old = active;
    if (old) {
      settle(old, { status: "superseded" });
      effects.push(() => old.controller.abort());
    }
    const controller = new AbortController();
    const state = history.snapshot();
    const attempt: OpenAttempt = Object.freeze({
      id: crypto.randomUUID(),
      entry: state.current,
      signal: controller.signal,
    });
    let resolve: (result: OpenResult) => void = () => {};
    const promise = new Promise<OpenResult>((settle) => {
      resolve = settle;
    });
    const operation: Operation = {
      attempt,
      controller,
      promise,
      resolve,
      pending: true,
    };
    active = operation;
    snapshot = Object.freeze({
      entry: state.current,
      attempt,
      status: "opening",
      canGoBack: state.canGoBack,
      canGoForward: state.canGoForward,
    });
    if (state.invalidAddress) {
      finish(operation, { status: "failed", reason: "invalid-target" });
      return promise;
    }
    operation.timer = setTimeout(
      () =>
        transaction(() => {
          finish(operation, { status: "failed", reason: "timeout" });
        }),
      timeoutMs,
    );
    emit();
    return promise;
  }
  let resolving: Operation | undefined;
  const unsubscribe = history.attach(() => {
    transaction(() => {
      if (resolving && active === resolving) {
        // Domain normalization keeps the caller, visit, signal and original deadline.
        // Rotate the immutable attempt token so an old presentation cannot complete it.
        const state = history.snapshot();
        active.attempt = Object.freeze({
          ...active.attempt,
          entry: state.current,
        });
        snapshot = Object.freeze({
          ...snapshot,
          entry: state.current,
          attempt: active.attempt,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
        });
        emit();
      } else start();
    });
  });
  transaction(start);
  const navigation: Navigation = Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(input: OpenTarget, options?: { replace?: boolean }) {
      return transaction(() => {
        if (disposed)
          return Promise.resolve<OpenResult>({ status: "cancelled" });
        let target: OpenTarget;
        try {
          target = parseOpenTarget(input);
        } catch {
          return Promise.resolve<OpenResult>({
            status: "failed",
            reason: "invalid-target",
          });
        }
        try {
          if (
            !history.snapshot().invalidAddress &&
            targetKey(target) === targetKey(history.snapshot().current.target)
          )
            return start();
          if (options?.replace) history.replace(target);
          else history.push(target);
          return active.promise;
        } catch {
          // Drivers commit atomically and notify only their exclusive controller.
          return Promise.resolve<OpenResult>({
            status: "failed",
            reason: "host-error",
          });
        }
      });
    },
    back() {
      transaction(() => {
        if (!disposed) history.back();
      });
    },
    forward() {
      transaction(() => {
        if (!disposed) history.forward();
      });
    },
    retry() {
      return transaction(start);
    },
  });
  return {
    navigation,
    /** Normalize a pending presentation, not a new intent; never reset its deadline. */
    resolve(attempt: OpenAttempt, input: OpenTarget) {
      return transaction(() => {
        if (
          disposed ||
          attempt !== active.attempt ||
          attempt.signal.aborted ||
          !active.pending
        )
          return false;
        try {
          const target = parseOpenTarget(input);
          if (targetKey(target) === targetKey(snapshot.entry.target))
            return true;
          resolving = active;
          history.resolve(target);
          return true;
        } catch {
          return false;
        } finally {
          resolving = undefined;
        }
      });
    },
    /** Acknowledge only the exact active attempt after actual presentation. */
    complete(
      attempt: OpenAttempt,
      result: Extract<OpenResult, { status: "opened" | "failed" }>,
    ) {
      return transaction(() => {
        if (
          disposed ||
          attempt !== active.attempt ||
          attempt.signal.aborted ||
          !active.pending
        )
          return false;
        finish(active, result);
        return true;
      });
    },
    cancel() {
      transaction(() => {
        const operation = active;
        finish(operation, { status: "cancelled" });
        effects.push(() => operation.controller.abort());
      });
    },
    dispose() {
      transaction(() => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        finish(active, { status: "cancelled" });
        const operation = active;
        effects.push(() => operation.controller.abort());
        listeners.clear();
        history.dispose();
      });
    },
  };
}
