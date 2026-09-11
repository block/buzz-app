import { expect, it } from "vitest";
import { createNavigationController } from "./controller";
import { createMemoryHistory } from "./history";
import type { OpenTarget } from "./targets";
const a: OpenTarget = { version: 1, kind: "settings", section: "appearance" };
const b: OpenTarget = { version: 1, kind: "settings", section: "plugins" };
it("each caller retains its result when a snapshot subscriber opens another target", async () => {
  const host = createNavigationController(createMemoryHistory());
  const nav = host.navigation;
  try {
    let second: ReturnType<typeof nav.open> | undefined;
    nav.subscribe(() => {
      const target = nav.snapshot().entry.target;
      if (target.kind === "settings" && target.section === "appearance")
        second = nav.open(b);
    });
    const first = nav.open(a);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(first).resolves.toEqual({ status: "superseded" });
    await expect(second).resolves.toEqual({ status: "opened" });
  } finally {
    host.dispose();
  }
});
it("an abort callback can open the winning target without orphaning another caller", async () => {
  const host = createNavigationController(createMemoryHistory());
  const nav = host.navigation;
  try {
    nav.snapshot().attempt.signal.addEventListener(
      "abort",
      () => {
        void nav.open(b);
      },
      { once: true },
    );
    const first = nav.open(a);
    expect(nav.snapshot().entry.target).toEqual(b);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(first).resolves.toEqual({ status: "superseded" });
  } finally {
    host.dispose();
  }
});
it("cancellation listeners cannot accidentally abort the new attempt", async () => {
  const host = createNavigationController(createMemoryHistory());
  const nav = host.navigation;
  try {
    const first = nav.open(a);
    let second: ReturnType<typeof nav.open> | undefined;
    nav.subscribe(() => {
      if (nav.snapshot().status === "cancelled") second = nav.open(b);
    });
    host.cancel();
    const attempt = nav.snapshot().attempt;
    expect(attempt.signal.aborted).toBe(false);
    expect(host.complete(attempt, { status: "opened" })).toBe(true);
    await expect(first).resolves.toEqual({ status: "cancelled" });
    await expect(second).resolves.toEqual({ status: "opened" });
  } finally {
    host.dispose();
  }
});
it("observer exceptions cannot suppress later observers or change open/retry outcomes", async () => {
  const history = createMemoryHistory();
  const host = createNavigationController(history);
  const nav = host.navigation;
  try {
    let observed = 0;
    nav.subscribe(() => {
      throw new Error("private plugin details");
    });
    nav.subscribe(() => {
      observed++;
    });
    const first = nav.open(a);
    expect(observed).toBeGreaterThan(0);
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(first).resolves.toEqual({ status: "opened" });
    const retry = nav.retry();
    host.complete(nav.snapshot().attempt, { status: "opened" });
    await expect(retry).resolves.toEqual({ status: "opened" });
  } finally {
    host.dispose();
  }
});
it("an aborted old attempt cannot re-open after host disposal", async () => {
  const host = createNavigationController(createMemoryHistory());
  const nav = host.navigation;
  const first = nav.open(a);
  let late: ReturnType<typeof nav.open> | undefined;
  nav.snapshot().attempt.signal.addEventListener("abort", () => {
    late = nav.open(b);
  });
  host.dispose();
  await expect(first).resolves.toEqual({ status: "cancelled" });
  await expect(late).resolves.toEqual({ status: "cancelled" });
  expect(nav.snapshot().entry.target).toEqual(a);
});
it("disposal from an old abort callback leaves no revived attempt or timer", async () => {
  const history = createMemoryHistory();
  let disposed = 0;
  const dispose = history.dispose;
  history.dispose = () => {
    disposed++;
    dispose();
  };
  const host = createNavigationController(history);
  const nav = host.navigation;
  nav
    .snapshot()
    .attempt.signal.addEventListener("abort", host.dispose, { once: true });
  const first = nav.open(a);
  await expect(first).resolves.toEqual({ status: "cancelled" });
  expect(disposed).toBe(1);
  expect(nav.snapshot().status).toBe("cancelled");
  expect(nav.snapshot().attempt.signal.aborted).toBe(true);
  await expect(nav.retry()).resolves.toEqual({ status: "cancelled" });
});
it("throwing observers cannot prevent history teardown", async () => {
  const history = createMemoryHistory();
  let disposed = 0;
  const dispose = history.dispose;
  history.dispose = () => {
    disposed++;
    dispose();
  };
  const host = createNavigationController(history);
  host.navigation.subscribe(() => {
    throw new Error("bad observer");
  });
  host.dispose();
  expect(disposed).toBe(1);
  expect(host.navigation.snapshot().attempt.signal.aborted).toBe(true);
});
it("history has one exclusive controller; UI observers cannot subscribe before or after it", () => {
  const history = createMemoryHistory();
  const host = createNavigationController(history);
  try {
    expect("subscribe" in history).toBe(false);
    expect(() =>
      history.attach(() => {
        void host.navigation.open(b);
      }),
    ).toThrow("already has an owner");
    expect(() => createNavigationController(history)).toThrow(
      "already has an owner",
    );
    const preowned = createMemoryHistory();
    const detach = preowned.attach(() => {});
    expect(() => createNavigationController(preowned)).toThrow(
      "already has an owner",
    );
    detach();
    expect(() => createNavigationController(preowned)).toThrow(
      "already has an owner",
    );
    preowned.dispose();
  } finally {
    host.dispose();
  }
});
