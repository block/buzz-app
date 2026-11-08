import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginModule } from "../../plugins/api";
import { provideNavigation } from "../navigation/service";
import { NotificationsService, type Notifications } from "./service";
import { createNotificationPreferences } from "./preferences";
// @ts-expect-error -- example plugins ship as untyped, prebuilt JavaScript.
import * as examplePack from "../../../examples/plugins/sound-pack/plugin.js";
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
  vi.unstubAllGlobals();
});
function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  let module: PluginModule = { apply() {} };
  const runtime = new PluginRuntime(ctx, async () => module);
  ctx.effect(() => () => runtime.dispose());
  const values = new Map<string, string>();
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
  let permission: NotificationPermissionState = "granted";
  const platform: NotificationPlatform = {
    label: "Test",
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
it("retains a fresh candidate for explicit permission, without prompting on arrival", async () => {
  const t = setup();
  t.permission("default");
  await t.submit();
  await flush();
  expect(t.platform.requestPermission).not.toHaveBeenCalled();
  expect(t.platform.show).not.toHaveBeenCalled();
  t.permission("granted");
  await t.service.requestPermission();
  await flush();
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
it("a plugin sound that is not installed plays the default and keeps the choice", async () => {
  const t = setup();
  t.service.updatePreferences({
    sounds: {
      mention: "example.sound-pack/chime",
      direct: "unison",
      thread: "doop",
      agent: "silent",
    },
  });
  await t.submit("one");
  await flush();
  expect(t.plays).toEqual(["flutter"]);
  expect(t.service.snapshot().preferences.sounds.mention).toBe(
    "example.sound-pack/chime",
  );
  // Solo chat completions share the same resolution.
  t.service.playCategorySound("agent");
  t.service.playCategorySound("thread");
  expect(t.plays).toEqual(["flutter", "doop"]);
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
function soundPack(id = "pack", sounds = ["chime"], bytes = 4) {
  return {
    id,
    label: "Example pack",
    sounds: sounds.map((sound) => ({
      id: sound,
      label: `Sound ${sound}`,
      audio: new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
    })),
  };
}
it("plugin sound packs join the alert path and leave with their plugin", async () => {
  const created = vi.spyOn(URL, "createObjectURL");
  const revoked = vi.spyOn(URL, "revokeObjectURL");
  const t = setup();
  let register: Notifications["sounds"]["register"] | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      register = (pack) => ctx.notifications.sounds.register(pack);
      ctx.notifications.sounds.register(soundPack("pack", ["chime", "done"]));
    },
  });
  await vi.waitFor(() =>
    expect(t.service.soundRegistry.snapshot()).toHaveLength(1),
  );
  expect(t.service.soundRegistry.snapshot()).toEqual([
    {
      key: "test.plugin/pack",
      label: "Example pack",
      sounds: [
        { ref: "test.plugin/chime", label: "Sound chime" },
        { ref: "test.plugin/done", label: "Sound done" },
      ],
    },
  ]);
  const chime = t.service.soundRegistry.source("test.plugin/chime");
  expect(chime).toMatch(/^blob:/);
  t.service.updatePreferences({
    sounds: {
      ...t.service.snapshot().preferences.sounds,
      mention: "test.plugin/chime",
    },
  });
  await t.submit("one");
  await flush();
  expect(t.plays).toEqual(["test.plugin/chime"]);

  const remove = register?.(soundPack("extra", ["bell"]));
  expect(t.service.soundRegistry.snapshot()).toHaveLength(2);
  remove?.();
  expect(t.service.soundRegistry.snapshot()).toHaveLength(1);
  expect(t.service.soundRegistry.isAvailable("test.plugin/bell")).toBe(false);

  t.disable();
  await flush();
  expect(t.service.soundRegistry.snapshot()).toEqual([]);
  expect(t.service.soundRegistry.isAvailable("test.plugin/chime")).toBe(false);
  expect(revoked.mock.calls.map(([url]) => url).sort()).toEqual(
    created.mock.results.map((result) => result.value).sort(),
  );
  await t.submit("two");
  await flush();
  expect(t.plays).toEqual(["test.plugin/chime", "flutter"]);
  expect(t.service.snapshot().preferences.sounds.mention).toBe(
    "test.plugin/chime",
  );
});
it("an invalid sound pack registers nothing", async () => {
  const created = vi.spyOn(URL, "createObjectURL");
  const t = setup();
  let register: Notifications["sounds"]["register"] | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      register = (pack) => ctx.notifications.sounds.register(pack);
    },
  });
  await vi.waitFor(() => expect(register).toBeDefined());
  const tooLarge = soundPack("big", ["huge"], 512 * 1024 + 1);
  const notAudio = {
    ...soundPack("text"),
    sounds: [{ id: "chime", label: "Chime", audio: "chime.mp3" }],
  } as unknown as ReturnType<typeof soundPack>;
  for (const pack of [
    soundPack("Bad Id"),
    { ...soundPack(), label: "" },
    soundPack("empty", []),
    soundPack(
      "many",
      Array.from({ length: 33 }, (_, i) => `s${i}`),
    ),
    soundPack("twice", ["chime", "chime"]),
    tooLarge,
  ])
    expect(() => register?.(pack)).toThrow(RangeError);
  expect(() => register?.(notAudio)).toThrow(TypeError);
  expect(created).not.toHaveBeenCalled();

  register?.(soundPack("pack", ["chime"]));
  expect(() => register?.(soundPack("pack", ["other"]))).toThrow(
    "duplicate pack id",
  );
  // Refs are `<pluginId>/<soundId>`, so ids are unique across a plugin's packs.
  expect(() => register?.(soundPack("second", ["chime"]))).toThrow(RangeError);
  for (let i = 1; i < 8; i++) register?.(soundPack(`p${i}`, [`s${i}`]));
  expect(() => register?.(soundPack("ninth", ["s9"]))).toThrow(RangeError);
  expect(t.service.soundRegistry.snapshot()).toHaveLength(8);
});
it("a plugin's sound packs share a 4 MiB audio budget", async () => {
  const t = setup();
  let register: Notifications["sounds"]["register"] | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      register = (pack) => ctx.notifications.sounds.register(pack);
    },
  });
  await vi.waitFor(() => expect(register).toBeDefined());
  const half = 512 * 1024;
  register?.(soundPack("one", ["a1", "a2", "a3", "a4"], half));
  register?.(soundPack("two", ["b1", "b2", "b3", "b4"], half));
  expect(() => register?.(soundPack("three", ["c1"], 1))).toThrow(
    "at most 4 MiB",
  );
});
it("a plugin sound that fails to load warns once and alerts fall back to the default", async () => {
  const instances: { onerror: (() => void) | null }[] = [];
  vi.stubGlobal(
    "Audio",
    class {
      currentTime = 0;
      onerror: (() => void) | null = null;
      play = vi.fn(async () => {});
      constructor() {
        instances.push(this);
      }
    },
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const t = setup();
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      ctx.notifications.sounds.register(soundPack());
    },
  });
  await vi.waitFor(() =>
    expect(t.service.soundRegistry.isAvailable("test.plugin/chime")).toBe(true),
  );
  t.service.soundRegistry.play("test.plugin/chime");
  instances[0]?.onerror?.();
  instances[0]?.onerror?.();
  expect(warn).toHaveBeenCalledOnce();
  expect(warn.mock.calls[0]?.[0]).toContain("test.plugin/chime");
  expect(t.service.soundRegistry.isAvailable("test.plugin/chime")).toBe(false);
  t.service.updatePreferences({
    sounds: {
      ...t.service.snapshot().preferences.sounds,
      mention: "test.plugin/chime",
    },
  });
  await t.submit("one");
  await flush();
  expect(t.plays).toEqual(["flutter"]);
});
it("the example Starship pack registers playable WAV sounds", async () => {
  const blobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return `blob:test/${blobs.length}`;
  });
  const t = setup();
  t.install(examplePack as PluginModule);
  await vi.waitFor(() =>
    expect(t.service.soundRegistry.snapshot()).toHaveLength(1),
  );
  const [pack] = t.service.soundRegistry.snapshot();
  expect(pack?.label).toBe("Starship");
  expect(pack?.sounds.map((sound) => sound.ref)).toEqual([
    "test.plugin/shield-recharge",
    "test.plugin/plasma-shot",
    "test.plugin/comms-ping",
    "test.plugin/mission-complete",
  ]);
  for (const blob of blobs) {
    expect(blob.type).toBe("audio/wav");
    const header = new Uint8Array(await blob.arrayBuffer()).subarray(0, 12);
    expect(new TextDecoder().decode(header)).toMatch(/^RIFF.{4}WAVE$/s);
  }
});
it("registering after the plugin's scope ended leaves no media URL behind", async () => {
  const created = vi.spyOn(URL, "createObjectURL");
  const revoked = vi.spyOn(URL, "revokeObjectURL");
  const t = setup();
  let notifications: Notifications | undefined;
  t.install({
    inject: ["notifications"],
    apply(ctx) {
      notifications = ctx.notifications;
    },
  });
  await vi.waitFor(() => expect(notifications).toBeDefined());
  t.disable();
  await flush();
  expect(() => notifications?.sounds.register(soundPack())).toThrow();
  expect(t.service.soundRegistry.snapshot()).toEqual([]);
  expect(revoked).toHaveBeenCalledTimes(created.mock.calls.length);
});
