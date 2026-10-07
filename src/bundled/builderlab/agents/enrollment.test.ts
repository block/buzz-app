import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createEnrollment } from "./enrollment";
import { enrollmentFixture } from "./enrollment-testing";
import type { RemoteAgent } from "./client";

const agent: RemoteAgent = {
  id: "one",
  name: "Helper",
  pubkey: "ab".repeat(32),
  status: "Active",
};
const owners: ReturnType<typeof enrollmentFixture>[] = [];
beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function fixture() {
  const login = createOAuthSession(async () => ({
    value: "secret",
    account: { subject: "user", email: "a@example.com" },
  }));
  await login.signIn();
  const h = enrollmentFixture(login);
  owners.push(h);
  return { ...h, login, signal: new AbortController().signal };
}

it("resumes a saved enrollment with the original signed event after a lost receipt", async () => {
  const h = await fixture();
  h.publish.mockRejectedValueOnce(new Error("receipt lost"));
  const context = h.enrollment.capture();
  h.enrollment.remember(context, agent);
  await expect(
    h.enrollment.publish(context, agent, h.signal, () => true),
  ).rejects.toThrow("receipt lost");
  await vi.waitFor(() => expect(h.saved()[0]?.delivery).toBe("unknown"));
  const first = h.publish.mock.calls[0]?.[0];
  await h.restart();
  const restored = createEnrollment(h.relay, h.reader, h.login);
  await restored.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(h.publish.mock.calls[1]?.[0]).toEqual(first);
  expect(h.sign).toHaveBeenCalledTimes(1);
  expect(restored.pending([agent])).toEqual([]);
});

it("recovers the activation-to-outbox gap only for intended Active agents", async () => {
  const h = await fixture();
  await h.enrollment.recover([agent], h.signal, () => true);
  expect(h.sign).not.toHaveBeenCalled();
  h.enrollment.remember(h.enrollment.capture(), agent);
  const restored = createEnrollment(h.relay, h.reader, h.login);
  for (const status of ["Unattested", "Revoked", "Unknown"] as const)
    await restored.recover([{ ...agent, status }], h.signal, () => true);
  expect(h.sign).not.toHaveBeenCalled();
  await restored.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(restored.pending([agent])).toEqual([]);
});

it.each(["community", "account", "card", "abort"])(
  "fences %s changes while relay signing is held",
  async (change) => {
    const h = await fixture();
    const gate = deferred<void>();
    const sign = h.sign.getMockImplementation();
    if (!sign) throw new Error("Missing signer");
    h.sign.mockImplementationOnce(async (event) => {
      await gate.promise;
      return sign(event);
    });
    const controller = new AbortController();
    let active = true;
    const context = h.enrollment.capture();
    h.enrollment.remember(context, agent);
    const result = h.enrollment
      .publish(context, agent, controller.signal, () => active)
      .catch((error) => error);
    try {
      await vi.waitFor(() => expect(h.sign).toHaveBeenCalledTimes(1));
      if (change === "community") h.setCommunity("https://other.example");
      if (change === "account") h.login.signOut();
      if (change === "card") active = false;
      if (change === "abort") controller.abort();
      gate.resolve();
      expect(await result).toBeInstanceOf(Error);
      await vi.waitFor(() =>
        expect(h.relay.snapshot().session.outbox?.snapshot()[0]?.delivery).toBe(
          "failed",
        ),
      );
      expect(h.publish).not.toHaveBeenCalled();
      if (change === "community") {
        expect(h.enrollment.pending([agent])).toEqual([]);
        h.setCommunity("https://community.example");
        expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
      }
    } finally {
      gate.resolve();
      await result;
    }
  },
);

it("retains accepted delivery when discovery fails, then refreshes without another publication", async () => {
  const h = await fixture();
  const query = h.query.getMockImplementation();
  if (!query) throw new Error("Missing reader");
  h.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(30175)))
      throw new Error("inventory unavailable");
    return query(filters);
  });
  h.enrollment.remember(h.enrollment.capture(), agent);
  await expect(
    h.enrollment.recover([agent], h.signal, () => true),
  ).rejects.toThrow("discovery is pending");
  expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
  h.query.mockImplementation(query);
  await h.enrollment.recover([agent], h.signal, () => true);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.enrollment.pending([agent])).toEqual([]);
});

it("drains an inventory read started before publication before refreshing discovery", async () => {
  const h = await fixture();
  const inventory = deferred<Awaited<ReturnType<typeof h.query>>>();
  h.query.mockImplementationOnce(() => inventory.promise);
  const prior = h.relay.snapshot().session.agentChoices.refresh();
  await vi.waitFor(() => expect(h.query).toHaveBeenCalledTimes(1));
  h.enrollment.remember(h.enrollment.capture(), agent);
  const recovered = h.enrollment.recover([agent], h.signal, () => true);
  try {
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledTimes(1));
    inventory.resolve([]);
    await prior;
    await recovered;
    expect(h.enrollment.pending([agent])).toEqual([]);
  } finally {
    inventory.resolve([]);
    await Promise.allSettled([prior, recovered]);
  }
});

it.each(["receipt dismissal", "intent removal"])(
  "recovers an interruption during %s after acknowledgment without republishing",
  async (boundary) => {
    const h = await fixture();
    h.enrollment.remember(h.enrollment.capture(), agent);
    const save = h.save.getMockImplementation();
    if (!save) throw new Error("Missing storage");
    if (boundary === "receipt dismissal") {
      h.save.mockImplementation(async (next) => {
        if (!next.length && h.events.length)
          throw new Error("cleanup interrupted");
        return save(next);
      });
    } else {
      vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
        throw new Error("cleanup interrupted");
      });
    }
    await expect(
      h.enrollment.recover([agent], h.signal, () => true),
    ).rejects.toThrow("cleanup interrupted");
    expect(h.enrollment.pending([agent])).toEqual([agent.pubkey]);
    if (boundary === "receipt dismissal")
      expect(h.saved()[0]?.acknowledged).toBe(true);
    h.save.mockImplementation(save);
    await h.restart();
    await h.enrollment.recover([agent], h.signal, () => true);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.relay.snapshot().session.outbox?.snapshot()).toEqual([]);
    expect(h.enrollment.pending([agent])).toEqual([]);
  },
);

it("does not recover another verified account's enrollment intent", async () => {
  const h = await fixture();
  h.enrollment.remember(h.enrollment.capture(), agent);
  const other = createOAuthSession(async () => ({
    value: "other-secret",
    account: { subject: "other", email: "a@example.com" },
  }));
  await other.signIn();
  const enrollment = createEnrollment(h.relay, h.reader, other);
  expect(enrollment.pending([agent])).toEqual([]);
  await enrollment.recover([agent], h.signal, () => true);
  expect(h.publish).not.toHaveBeenCalled();
});
