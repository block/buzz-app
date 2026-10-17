import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import {
  DECISION_BACKEND_KEY,
  DecisionsService,
  type DecisionRequest,
  type DecisionsNative,
} from "./service";

const request: DecisionRequest = {
  state: "The build is broken on main.",
  questions: {
    urgent: { type: "yes_no", instructions: "It needs attention now." },
  },
};
function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  } as unknown as Storage & { values: Map<string, string> };
}
const answered = (backend: string) => ({
  outcome: "answered",
  backend,
  model: "jev-1.13.0",
  answers: { urgent: { type: "yes_no", probability: 0.8 } },
});

it("asks Block by default and returns native's checked answers", async () => {
  const native = vi.fn<DecisionsNative>(async (backend) => answered(backend));
  const service = new DecisionsService(new Context(), native, memory());
  expect(service.backend()).toBe("block");
  await expect(service.decide(request)).resolves.toEqual(answered("block"));
  expect(native).toHaveBeenCalledWith("block", request);
});

it("uses and saves the backend Settings chooses, and tells subscribers", async () => {
  const storage = memory();
  const native = vi.fn<DecisionsNative>(async (backend) => answered(backend));
  const service = new DecisionsService(new Context(), native, storage);
  const listener = vi.fn();
  // Unbound, as React's useSyncExternalStore calls them.
  const { backend, subscribe } = service;
  const stop = subscribe(listener);
  service.setBackend("typesafe");
  expect(backend()).toBe("typesafe");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(storage.values.get(DECISION_BACKEND_KEY)).toBe("typesafe");
  await service.decide(request);
  expect(native).toHaveBeenLastCalledWith("typesafe", request);
  // Choosing the same backend again, or an unknown one, changes nothing.
  service.setBackend("typesafe");
  service.setBackend("other" as never);
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  service.setBackend("block-openai");
  expect(listener).toHaveBeenCalledTimes(1);
  // A later start restores it.
  expect(new DecisionsService(new Context(), native, storage).backend()).toBe(
    "block-openai",
  );
});

it("ignores a saved value that is not a backend, and unreadable storage", () => {
  const native = vi.fn<DecisionsNative>();
  const junk = memory({ [DECISION_BACKEND_KEY]: "openai" });
  expect(new DecisionsService(new Context(), native, junk).backend()).toBe(
    "block",
  );
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  } as unknown as Storage;
  const service = new DecisionsService(new Context(), native, broken);
  expect(service.backend()).toBe("block");
  service.setBackend("typesafe");
  expect(service.backend()).toBe("typesafe");
});

it("never rejects: no native, refused arguments and a wrong reply are failures", async () => {
  await expect(
    new DecisionsService(new Context(), undefined, memory()).decide(request),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "block",
    reason: "unavailable",
  });
  const refused = vi.fn<DecisionsNative>(async () => {
    throw "invalid args `request` for command `decide`";
  });
  await expect(
    new DecisionsService(new Context(), refused, memory()).decide(request),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "block",
    reason: "invalid_request",
  });
  for (const reply of [
    null,
    {},
    answered("typesafe"),
    { outcome: "answered", backend: "block" },
  ]) {
    const odd = vi.fn<DecisionsNative>(async () => reply);
    await expect(
      new DecisionsService(new Context(), odd, memory()).decide(request),
    ).resolves.toEqual({
      outcome: "failed",
      backend: "block",
      reason: "invalid_response",
    });
  }
  const failed = { outcome: "failed", backend: "block", reason: "timeout" };
  await expect(
    new DecisionsService(new Context(), async () => failed, memory()).decide(
      request,
    ),
  ).resolves.toEqual(failed);
});

it("keeps the backend a call started with when Settings changes it mid-call", async () => {
  let release!: () => void;
  const native = vi.fn<DecisionsNative>(
    (backend) =>
      new Promise((resolve) => (release = () => resolve(answered(backend)))),
  );
  const service = new DecisionsService(new Context(), native, memory());
  const pending = service.decide(request);
  service.setBackend("typesafe");
  release();
  await expect(pending).resolves.toEqual(answered("block"));
});

it("is the injected ctx.decisions plugins get", async () => {
  const ctx = new Context();
  const native = vi.fn<DecisionsNative>(async (backend) => answered(backend));
  new DecisionsService(ctx, native, memory());
  const seen = new Promise<unknown>((resolve) =>
    ctx.inject(["decisions"], (child) =>
      resolve(child.decisions.decide(request)),
    ),
  );
  await expect(seen).resolves.toEqual(answered("block"));
});
