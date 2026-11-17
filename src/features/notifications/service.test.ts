import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginModule } from "../../plugins/api";
import { provideNavigation } from "../navigation/service";
import { NotificationsService, type Notifications } from "./service";
import { createNotificationPreferences } from "./preferences";
import type {
  NotificationPlatform,
  NotificationPermissionState,
} from "./platform";

const viewer = "a".repeat(64);
const target = {
  version: 1,
  kind: "settings",
  section: "notifications",
} as const;
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function setup(
  options: {
    requestsOnArrival?: boolean;
    permission?: NotificationPermissionState;
    values?: Map<string, string>;
  } = {},
) {
  const ctx = new Context();
  contexts.push(ctx);
  let module: PluginModule = { apply() {} };
  const runtime = new PluginRuntime(ctx, async () => module);
  ctx.effect(() => () => runtime.dispose());
  const values = options.values ?? new Map<string, string>();
  const host = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window;
  const preferences = createNotificationPreferences(host);
  const navigation = provideNavigation(ctx);
  const clicks: (() => void)[] = [];
  const failures: ((error: Error) => void)[] = [];
  let permission = options.permission ?? "granted";
  const platform: NotificationPlatform = {
    label: "Test",
    ...(options.requestsOnArrival ? { requestsOnArrival: true } : {}),
    permission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => permission),
    show: vi.fn(async (_item, activate, failed) => {
      clicks.push(activate);
      failures.push(failed);
    }),
    dispose: vi.fn(),
  };
  const plays: string[] = [];
  const service = new NotificationsService(
    ctx,
    navigation.navigation,
    platform,
    preferences,
    undefined,
    (name) => plays.push(name),
  );
  service.selectViewer(viewer);
  return {
    ctx,
    service,
    preferences,
    platform,
    navigation,
    clicks,
    failures,
    values,
    host,
    plays,
    permission(value: NotificationPermissionState) {
      permission = value;
    },
    submit(id = "event", eligible: () => boolean | "wait" = () => true) {
      return service.admit(
        "mention",
        "Mentions",
        { sourceKey: id, target },
        () => true,
        eligible,
      );
    },
    install(value: PluginModule) {
      module = value;
      runtime.reconcile([
        {
          manifest: { id: "test.plugin", name: "Test plugin", apiVersion: 1 },
          enabled: true,
          source: "external",
          revision: "v1",
          previous: null,
          reloadable: true,
          error: null,
        },
      ]);
    },
    disable() {
      runtime.reconcile([]);
    },
  };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
const askedKey = "buzz-notification-permission-asked.v1";
/** A fresh install on a platform that may ask on arrival: the OS reports not yet asked. */
function firstRun(values?: Map<string, string>) {
  return setup({
    requestsOnArrival: true,
    permission: "default",
    ...(values ? { values } : {}),
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("deduplicates in this running session and routes clicks through existing navigation", async () => {
  const t = setup();
  expect(await t.submit()).toBe(true);
  expect(await t.submit()).toBe(false);
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry.target).toEqual(target);
  expect(t.navigation.navigation.snapshot().status).toBe("opening");
});
it("more than 256 sequential alerts do not fill a persistent inbox or pause delivery", async () => {
  const t = setup();
  for (let i = 0; i < 300; i++) {
    expect(await t.submit(String(i))).toBe(true);
    await flush();
  }
  expect(t.platform.show).toHaveBeenCalledTimes(300);
  expect(t.service.snapshot().error).toBeNull();
  expect(Object.keys(t.service.snapshot())).not.toContain("records");
});
it("a platform that cannot ask on arrival retains a fresh candidate for explicit permission", async () => {
  const t = setup();
  t.permission("default");
  await t.submit();
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
  expect(t.platform.show).not.toHaveBeenCalled();
  t.permission("granted");
  await t.service.requestPermission();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("simultaneous and later first-run alerts send one system request, which replaces the first alert", async () => {
  const t = firstRun();
  const answer = deferred<NotificationPermissionState>();
  vi.mocked(t.platform.requestPermission).mockReturnValueOnce(answer.promise);
  try {
    await Promise.all(["one", "two", "three"].map((id) => t.submit(id)));
    await flush();
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
    expect(t.service.snapshot().requesting).toBe(true);
    expect(t.values.get(askedKey)).toBe("1");
    await t.submit("later");
    await flush();
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
    expect(t.platform.show).not.toHaveBeenCalled();
  } finally {
    t.permission("granted");
    answer.resolve("granted");
    await flush();
  }
  expect(t.service.snapshot()).toMatchObject({
    requesting: false,
    permission: "granted",
  });
  // The prompt replaced the alert that triggered it; the others were held as
  // any alert is while the OS has not been asked.
  expect(t.platform.show).toHaveBeenCalledTimes(3);
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
});
it("allowing the automatic prompt does not bring back the alert it replaced", async () => {
  const t = firstRun();
  vi.mocked(t.platform.requestPermission).mockImplementationOnce(async () => {
    t.permission("granted");
    return "granted";
  });
  await t.submit();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.service.snapshot()).toMatchObject({
    requesting: false,
    permission: "granted",
  });
  expect(t.platform.show).not.toHaveBeenCalled();
  await t.submit("next");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it.each(["denied", "unknown", "unsupported"] as const)(
  "%s permission never asks on arrival",
  async (permission) => {
    const t = setup({ requestsOnArrival: true, permission });
    await t.submit();
    await flush();
    // The construction read and this alert's own probe both completed.
    expect(t.platform.permission).toHaveBeenCalledTimes(2);
    expect(t.platform.requestPermission).not.toHaveBeenCalled();
    expect(t.values.has(askedKey)).toBe(false);
    expect(t.platform.show).toHaveBeenCalledTimes(
      permission === "unknown" ? 1 : 0,
    );
  },
);
it("a stale not-yet-asked reading never asks once the OS itself reports a denial", async () => {
  const t = firstRun();
  await flush();
  expect(t.service.snapshot().permission).toBe("default");
  const probe = deferred<NotificationPermissionState>();
  const refresh = deferred<NotificationPermissionState>();
  vi.mocked(t.platform.permission)
    .mockReturnValueOnce(probe.promise)
    .mockReturnValueOnce(refresh.promise);
  try {
    await t.submit();
    await flush();
    // A newer read supersedes the alert's probe, which then falls back to the
    // last published state: still "default".
    void t.service.refreshPermission();
    expect(t.platform.permission).toHaveBeenCalledTimes(3);
    probe.resolve("denied");
    await flush();
    expect(t.platform.requestPermission).not.toHaveBeenCalled();
    expect(t.values.has(askedKey)).toBe(false);
  } finally {
    t.permission("denied");
    probe.resolve("denied");
    refresh.resolve("denied");
    await flush();
  }
  expect(t.service.snapshot().permission).toBe("denied");
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.platform.show).not.toHaveBeenCalled();
});
it.each<[string, (t: ReturnType<typeof setup>) => Promise<unknown>]>([
  [
    "alerts turned off",
    (t) => {
      t.service.updatePreferences({ enabled: false });
      return t.submit();
    },
  ],
  [
    "a disabled category",
    (t) => {
      t.service.updatePreferences({ categories: { mention: false } });
      return t.submit();
    },
  ],
  ["unknown read readiness", (t) => t.submit("waiting", () => "wait")],
  ["a conversation in view", (t) => t.submit("seen", () => false)],
  [
    "a plugin gate",
    async (t) => {
      t.install({
        inject: ["notifications"],
        apply(ctx) {
          ctx.notifications.gate({ id: "solo", allows: () => false });
        },
      });
      await vi.waitFor(() => expect(t.service.gated(target)).toBe(false));
      return t.submit();
    },
  ],
])("%s never asks on arrival", async (_name, arrive) => {
  const t = firstRun();
  await arrive(t);
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
});
it("the development pause never asks on arrival", async () => {
  vi.stubEnv("VITE_BUZZ_NOTIFICATIONS_PAUSED", "1");
  const t = firstRun();
  expect(t.service.snapshot().developmentPaused).toBe(true);
  expect(await t.submit()).toBe(false);
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
});
it("an alert that stops being eligible during its permission probe never asks", async () => {
  const t = firstRun();
  await flush();
  const probe = deferred<NotificationPermissionState>();
  vi.mocked(t.platform.permission).mockReturnValueOnce(probe.promise);
  let eligible: boolean | "wait" = true;
  try {
    await t.submit("opened", () => eligible);
    await flush();
    expect(t.platform.permission).toHaveBeenCalledTimes(2);
    eligible = "wait";
  } finally {
    probe.resolve("default");
    await flush();
  }
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.values.has(askedKey)).toBe(false);
  // Still the first alert that would have shown: it asks once eligible again.
  eligible = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
});
it("an ignored automatic request is not reported, retried or repeated, and keeps a shown error", async () => {
  const t = firstRun();
  t.service.reportError(new Error("Earlier failure"));
  vi.mocked(t.platform.requestPermission).mockRejectedValueOnce(
    new Error("Timed out waiting for notification permission"),
  );
  await t.submit();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.service.snapshot()).toMatchObject({
    requesting: false,
    error: "Earlier failure",
  });
  await t.submit("next");
  t.service.revalidate();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.platform.show).not.toHaveBeenCalled();
  // The explicit request still reports its own failure.
  vi.mocked(t.platform.requestPermission).mockRejectedValueOnce(
    new Error("Permission request failed"),
  );
  await t.service.requestPermission();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(2);
  expect(t.service.snapshot().error).toBe("Permission request failed");
});
it("the automatic request is remembered on this device across runs and accounts; explicit Allow still asks", async () => {
  const first = firstRun();
  await first.submit();
  await flush();
  expect(first.platform.requestPermission).toHaveBeenCalledTimes(1);
  await first.ctx.fiber.dispose();
  // A later run whose OS still reports not yet asked (an ignored banner), as
  // another account on the same device.
  const next = firstRun(first.values);
  next.service.selectViewer("b".repeat(64));
  await next.submit();
  await flush();
  expect(next.platform.requestPermission).not.toHaveBeenCalled();
  expect(next.platform.show).not.toHaveBeenCalled();
  // Its alert is held, not replaced, and the explicit request ignores the flag.
  next.permission("granted");
  await next.service.requestPermission();
  await flush();
  expect(next.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(next.platform.show).toHaveBeenCalledTimes(1);
});
it("a device that cannot record the automatic request never sends it", async () => {
  const t = firstRun();
  vi.spyOn(t.host.localStorage, "setItem").mockImplementation(() => {
    throw new Error("disk");
  });
  await t.submit();
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  t.permission("granted");
  await t.service.requestPermission();
  await flush();
  expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("an alert arriving during an explicit request is kept for its answer and spends no automatic request", async () => {
  const t = firstRun();
  const answer = deferred<NotificationPermissionState>();
  vi.mocked(t.platform.requestPermission).mockReturnValueOnce(answer.promise);
  const allow = t.service.requestPermission();
  try {
    await t.submit();
    await flush();
    expect(t.platform.permission).toHaveBeenCalledTimes(2);
    expect(t.platform.requestPermission).toHaveBeenCalledTimes(1);
    expect(t.values.has(askedKey)).toBe(false);
  } finally {
    t.permission("granted");
    answer.resolve("granted");
    await allow;
    await flush();
  }
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("an off/on transition during a permission probe cancels the old candidate", async () => {
  const t = setup();
  await flush();
  let release!: (value: NotificationPermissionState) => void;
  vi.mocked(t.platform.permission).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.submit();
  await flush();
  expect(release).toBeTypeOf("function");
  t.service.updatePreferences({ enabled: false });
  t.service.updatePreferences({ enabled: true });
  release("granted");
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
});
it("readiness rechecks fresh candidates; expired candidates never reappear", async () => {
  const t = setup();
  let ready = false;
  await t.submit("waiting", () => (ready ? true : "wait"));
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
  ready = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  ready = false;
  await t.submit("old", () => (ready ? true : "wait"));
  await flush();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 121000);
  ready = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("submission failure is reported once; unrelated alerts are not blocked", async () => {
  const t = setup();
  vi.mocked(t.platform.show).mockRejectedValueOnce(
    new Error("OS outcome unknown"),
  );
  await t.submit();
  await flush();
  expect(t.service.snapshot().error).toBe("OS outcome unknown");
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  await t.submit("next");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(2);
});
it("old account and disposed-host callbacks cannot navigate", async () => {
  const t = setup();
  await t.submit();
  await flush();
  const before = t.navigation.navigation.snapshot().entry;
  t.service.selectViewer("b".repeat(64));
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry).toBe(before);
  await t.submit("other");
  await flush();
  await t.ctx.fiber.dispose();
  t.clicks[1]?.();
  expect(t.navigation.navigation.snapshot().entry).toBe(before);
});
it("installed plugins share the host policy and stale producer handles are rejected", async () => {
  const t = setup();
  let producer: ReturnType<Notifications["register"]> | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      producer = ctx.notifications.register({
        id: "updates",
        label: "Updates",
      });
    },
  });
  await vi.waitFor(() => expect(producer).toBeDefined());
  expect(await producer?.submit({ sourceKey: "one", target })).toBe(true);
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.disable();
  await flush();
  expect(await producer?.submit({ sourceKey: "two", target })).toBe(false);
  t.clicks[0]?.();
  expect(t.navigation.navigation.snapshot().entry.target).toEqual(target);
});
it("a plugin alert's eligibility is asked again until delivery", async () => {
  const t = setup();
  let producer: ReturnType<Notifications["register"]> | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      producer = ctx.notifications.register({ id: "posts", label: "Posts" });
    },
  });
  await vi.waitFor(() => expect(producer).toBeDefined());
  t.permission("default");
  let eligible: boolean | "wait" = true;
  const held = { sourceKey: "held", target, eligible: () => eligible };
  expect(await producer?.submit(held)).toBe(true);
  await flush();
  eligible = false;
  t.permission("granted");
  await t.service.refreshPermission();
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
  eligible = "wait";
  expect(await producer?.submit({ ...held, sourceKey: "waiting" })).toBe(true);
  expect(
    await producer?.submit({
      sourceKey: "broken",
      target,
      eligible() {
        throw new Error("plugin bug");
      },
    }),
  ).toBe(true);
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
  eligible = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});
it("plugin gates silence alerts until removed or the plugin is disabled", async () => {
  const t = setup();
  let gate: Notifications["gate"] | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      gate = (value) => ctx.notifications.gate(value);
      ctx.notifications.gate({
        id: "broken",
        allows() {
          throw new Error("skipped");
        },
      });
    },
  });
  await vi.waitFor(() => expect(gate).toBeDefined());
  const remove = gate?.({
    id: "solo",
    allows: (value) => value.kind === "conversation",
  });
  expect(t.service.gated(target)).toBe(false);
  expect(await t.submit("gated")).toBe(false);
  remove?.();
  expect(t.service.gated(target)).toBe(true);
  gate?.({ id: "solo", allows: () => false });
  expect(t.service.gated(target)).toBe(false);
  t.disable();
  await flush();
  expect(t.service.gated(target)).toBe(true);
  expect(await t.submit("released")).toBe(true);
});
it("a gate added while an alert is pending keeps it from showing", async () => {
  const t = setup();
  let gate: Notifications["gate"] | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      gate = (value) => ctx.notifications.gate(value);
    },
  });
  await vi.waitFor(() => expect(gate).toBeDefined());
  let ready: boolean | "wait" = "wait";
  expect(await t.submit("waiting", () => ready)).toBe(true);
  gate?.({ id: "solo", allows: () => false });
  ready = true;
  t.service.revalidate();
  await flush();
  expect(t.platform.show).not.toHaveBeenCalled();
});
it("off takes effect despite storage failure and account preferences stay separate", () => {
  const t = setup();
  t.service.updatePreferences({ categories: { mention: false }, sound: false });
  t.service.selectViewer("b".repeat(64));
  expect(t.service.snapshot().preferences.sound).toBe(true);
  t.service.selectViewer(viewer);
  expect(t.service.snapshot().preferences.categories.mention).toBe(false);
  vi.spyOn(t.host.localStorage, "setItem").mockImplementation(() => {
    throw new Error("disk");
  });
  expect(t.service.updatePreferences({ enabled: false })).toBe(false);
  expect(t.service.snapshot().preferences.enabled).toBe(false);
  expect(t.service.snapshot().preferencesError).toContain("could not be saved");
});

it("a slow old permission probe cannot strand an alert after Allow completes", async () => {
  const t = setup();
  await flush();
  t.permission("default");
  let release!: (permission: NotificationPermissionState) => void;
  vi.mocked(t.platform.permission).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.submit();
  await flush();
  t.permission("granted");
  await t.service.requestPermission();
  await flush();
  release("default");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
});

it("late platform errors report without retry and stay fenced to their account lifetime", async () => {
  const t = setup();
  await t.submit();
  await flush();
  t.failures[0]?.(new Error("Late display failure"));
  expect(t.service.snapshot().error).toBe("Late display failure");
  t.service.revalidate();
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  t.service.selectViewer("b".repeat(64));
  t.failures[0]?.(new Error("Old account failure"));
  expect(t.service.snapshot().error).toBeNull();
  await t.ctx.fiber.dispose();
  t.failures[0]?.(new Error("Disposed failure"));
  expect(t.service.snapshot().error).toBeNull();
});
it("plays the selected per-category sound once delivery is accepted", async () => {
  const t = setup();
  t.service.updatePreferences({
    sounds: {
      mention: "ping",
      direct: "unison",
      thread: "doop",
      agent: "doodone",
    },
  });
  await t.submit("one");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  expect(t.plays).toEqual(["ping"]);
  // Plugin categories have no per-category choice; they use the default sound.
  await t.service.admit(
    "updates",
    "Updates",
    { sourceKey: "two", target },
    () => true,
  );
  await flush();
  expect(t.plays).toEqual(["ping", "flutter"]);
});
it("sound off delivers silently and a failed submission never plays", async () => {
  const t = setup();
  t.service.updatePreferences({ sound: false });
  await t.submit("one");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(1);
  expect(t.plays).toEqual([]);
  t.service.updatePreferences({ sound: true });
  vi.mocked(t.platform.show).mockRejectedValueOnce(
    new Error("SDK unavailable"),
  );
  await t.submit("two");
  await flush();
  expect(t.platform.show).toHaveBeenCalledTimes(2);
  expect(t.plays).toEqual([]);
  expect(t.service.snapshot().error).toBe("SDK unavailable");
});
it("a deferred submission revalidates the sound decision before playing", async () => {
  const t = setup();
  const releases: (() => void)[] = [];
  vi.mocked(t.platform.show).mockImplementation(
    (_item, activate, failed) =>
      new Promise<void>((resolve) => {
        t.clicks.push(activate);
        t.failures.push(failed);
        releases.push(resolve);
      }),
  );
  const settle = async () => {
    releases.shift()?.();
    await flush();
  };
  // Signing out or switching accounts while the submission is outstanding
  // must not leak the prior account's activity as audio.
  await t.submit("switched");
  await flush();
  t.service.selectViewer("b".repeat(64));
  await settle();
  expect(t.plays).toEqual([]);
  t.service.selectViewer(viewer);
  // Turning Sound off mid-flight cancels the outstanding decision — stickily:
  // restoring it before the submission resolves must not resurrect the sound.
  await t.submit("muted");
  await flush();
  t.service.updatePreferences({ sound: false });
  t.service.updatePreferences({ sound: true });
  await settle();
  expect(t.plays).toEqual([]);
  // Master alerts off → on mid-flight stays cancelled.
  await t.submit("alerts-toggled");
  await flush();
  t.service.updatePreferences({ enabled: false });
  t.service.updatePreferences({ enabled: true });
  await settle();
  expect(t.plays).toEqual([]);
  // A banner submitted while Sound was off stays silent after off → on.
  t.service.updatePreferences({ sound: false });
  await t.submit("resurrected");
  await flush();
  t.service.updatePreferences({ sound: true });
  await settle();
  expect(t.plays).toEqual([]);
  // Disabling the category mid-flight cancels the sound, even if re-enabled.
  await t.submit("category-off");
  await flush();
  t.service.updatePreferences({ categories: { mention: false } });
  t.service.updatePreferences({ categories: { mention: true } });
  await settle();
  expect(t.plays).toEqual([]);
  // Losing eligibility (access/producer revocation) mid-flight cancels it,
  // even when eligibility is restored before the submission resolves.
  let eligible: boolean | "wait" = true;
  await t.submit("revoked", () => eligible);
  await flush();
  eligible = false;
  t.service.revalidate();
  eligible = true;
  await settle();
  expect(t.plays).toEqual([]);
  // A native failure can arrive before the command promise resolves. It cancels
  // audio without retrying the accepted candidate.
  await t.submit("early-failure");
  await flush();
  t.failures.at(-1)?.(new Error("Backend rejected notification"));
  await settle();
  expect(t.plays).toEqual([]);
  expect(t.service.snapshot().error).toBe("Backend rejected notification");
  expect(t.platform.show).toHaveBeenCalledTimes(7);
  // An undisturbed deferred submission still plays exactly once.
  await t.submit("intact");
  await flush();
  expect(t.plays).toEqual([]);
  await settle();
  expect(t.plays).toEqual(["flutter"]);
});

it.each(["mention"] as const)(
  "Silent for %s preserves banners and other categories' audio across reload",
  async (category) => {
    const t = setup();
    t.service.updatePreferences({
      sounds: {
        ...t.service.snapshot().preferences.sounds,
        [category]: "silent",
      },
    });
    t.service.reloadPreferences();
    expect(t.service.snapshot().preferences.sounds[category]).toBe("silent");
    await t.service.admit(
      category,
      category,
      { sourceKey: "silent", target },
      () => true,
    );
    await flush();
    expect(t.platform.show).toHaveBeenCalledTimes(1);
    expect(t.plays).toEqual([]);
    const other = category === "mention" ? "direct" : "mention";
    await t.service.admit(
      other,
      other,
      { sourceKey: "audible", target },
      () => true,
    );
    await flush();
    expect(t.platform.show).toHaveBeenCalledTimes(2);
    expect(t.plays).toEqual(["flutter"]);
  },
);

it.each([true, false])(
  "Silent before=%s or during submission cannot resurrect pending audio",
  async (initiallySilent) => {
    const t = setup();
    const sounds = t.service.snapshot().preferences.sounds;
    if (initiallySilent)
      t.service.updatePreferences({ sounds: { ...sounds, mention: "silent" } });
    let release!: () => void;
    vi.mocked(t.platform.show).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await t.submit("pending");
    await flush();
    expect(t.platform.show).toHaveBeenCalledOnce();
    try {
      t.service.updatePreferences({ sounds: { ...sounds, mention: "silent" } });
      t.service.updatePreferences({ sounds });
    } finally {
      release();
      await flush();
    }
    expect(t.plays).toEqual([]);
  },
);

it("plugin display text is flattened and bounded, with the category text as fallback", async () => {
  const t = setup();
  let producer: ReturnType<Notifications["register"]> | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      producer = ctx.notifications.register({
        id: "updates",
        label: "Updates",
      });
    },
  });
  await vi.waitFor(() => expect(producer).toBeDefined());
  await producer?.submit({
    sourceKey: "rich",
    target,
    title: `Due\u0007 **now**\n${"t".repeat(200)}`,
    body: `**Call** [Ana](https://x.example)\n\n<b>raw</b> ${"b".repeat(300)}`,
  });
  await producer?.submit({ sourceKey: "plain", target });
  await expect(
    producer?.submit({ sourceKey: "bad", target, body: 1 as never }),
  ).rejects.toThrow("Invalid notification text");
  await flush();
  const shown = vi.mocked(t.platform.show).mock.calls.map(([item]) => item);
  const [rich = { title: "", body: "" }] = shown;
  expect(Array.from(rich.title)).toHaveLength(128);
  expect(rich.title.startsWith(`Due **now** ttt`)).toBe(true);
  expect(rich.title.endsWith("…")).toBe(true);
  expect(rich.body.startsWith("Call Ana <b>raw</b> bbb")).toBe(true);
  expect(Array.from(rich.body)).toHaveLength(200);
  expect(shown[1]).toMatchObject({ title: "Buzz", body: "New updates" });
});
