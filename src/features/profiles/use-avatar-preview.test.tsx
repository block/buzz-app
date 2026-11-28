// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayBrokerPlugin } from "../../../browser-host/relay-broker.mjs";
import { keypair } from "../relay/testing";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { retryFailedImages } from "../../shared/design-system/useReadyImage";
import { AvatarEditor } from "./AvatarEditor";
import { useAvatarAnimation, useAvatarPreview } from "./use-avatar-preview";

const community = "https://unjoined.example";
const picture = `${community}/media/${"a".repeat(64)}.png`;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Card({ value, relay }: { value: string; relay: string }) {
  const src = useAvatarPreview(value, relay);
  return <Avatar src={src} alt="Agent" fallback="Agent" />;
}
function preview(kind: "card" | "editor", value = picture, relay = community) {
  return kind === "card" ? (
    <Card value={value} relay={relay} />
  ) : (
    <AvatarEditor
      value={value}
      name="Agent"
      community={relay}
      onChange={() => {}}
    />
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["card", "editor"] as const)(
  "%s registers a persisted avatar destination on a fresh production broker before exposing its image",
  async (kind) => {
    const identity = keypair();
    const upstream = vi.fn(
      async () =>
        new Response("fixture", { headers: { "Content-Type": "image/png" } }),
    );
    let handler: RequestListener | undefined;
    const server = createServer((req, res) => handler?.(req, res));
    const plugin = relayBrokerPlugin({
      archiveFile: ":memory:",
      identity: () => identity.secret,
      upstreamFetch: upstream,
    });
    await (plugin.configureServer as (s: ViteDevServer) => Promise<void>)({
      httpServer: server,
      config: { logger: { info() {}, error() {} } },
      middlewares: {
        use(cb: RequestListener) {
          handler = cb;
        },
      },
    } as unknown as ViteDevServer);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const nativeFetch = globalThis.fetch;
    const gate = deferred();
    const started = deferred();
    const brokerUrl = `/api/relay/${encodeURIComponent(community)}/media?url=${encodeURIComponent(picture)}`;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      requests.push(input);
      if (input.endsWith("/register")) {
        started.resolve();
        await gate.promise;
      }
      return nativeFetch(new URL(input, base), {
        ...init,
        headers: { ...init?.headers, Origin: base },
      });
    });
    try {
      expect((await nativeFetch(`${base}${brokerUrl}`)).status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
      render(preview(kind), { wrapper: ToastProvider });
      await act(async () => {
        await started.promise;
      });
      expect(document.querySelector("img")).toBeNull();
      await act(async () => {
        gate.resolve();
      });
      await waitFor(() =>
        expect(document.querySelector("img")).toHaveAttribute("src", brokerUrl),
      );
      const response = await nativeFetch(
        `${base}${document.querySelector("img")?.getAttribute("src")}`,
      );
      expect(response.status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(requests).toEqual(["/api/relay/register"]); // No session, membership, or discovery dependency.
      const image = document.querySelector("img");
      if (!image) throw new Error("Registered avatar did not mount");
      fireEvent.load(image);
      expect(document.querySelector("img")).toHaveAttribute(
        "data-loaded",
        "true",
      );
      if (kind === "editor") {
        fireEvent.click(screen.getByRole("button", { name: "Edit avatar" }));
        const artwork = await screen.findByRole("img", {
          name: "Avatar preview",
        });
        await waitFor(() =>
          expect(artwork.querySelector("img")).toHaveAttribute(
            "src",
            brokerUrl,
          ),
        );
      }
    } finally {
      gate.resolve();
      cleanup();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it("retires registration on destination change and unmount, ignoring late completion", async () => {
  const gates = [deferred(), deferred()] as const;
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn(async (_input: string, init?: RequestInit) => {
    const index = signals.length;
    signals.push(init?.signal as AbortSignal);
    const gate = gates[index];
    if (!gate) throw new Error("Unexpected extra registration");
    await gate.promise;
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(preview("card"));
  await waitFor(() => expect(signals).toHaveLength(1));
  view.rerender(
    preview(
      "card",
      `https://second.example/media/${"b".repeat(64)}.png`,
      "https://second.example",
    ),
  );
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => {
    gates[0].resolve();
    await gates[0].promise;
  });
  expect(document.querySelector("img")).toBeNull();
  view.unmount();
  expect(signals[1]?.aborted).toBe(true);
  await act(async () => {
    gates[1].resolve();
    await gates[1].promise;
  });
});

it("keeps initials after rejected registration and never registers public artwork", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: "Denied" }, { status: 403 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const view = render(preview("card"));
  await act(async () => {
    await fetcher.mock.results[0]?.value;
  });
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("img", { name: "Agent" })).toHaveTextContent("A");
  view.rerender(preview("card", "https://images.example/public.png"));
  expect(document.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/public.png",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

describe("an animated avatar", () => {
  const animation = `${community}/media/${"b".repeat(64)}.png`;
  const descriptor = `${picture}#buzz-anim=${encodeURIComponent(animation)}`;
  /** Images the hook preloads, each decoding as `decode` says. */
  function preloads(decode: () => Promise<void>) {
    const sources: string[] = [];
    vi.stubGlobal(
      "Image",
      class {
        set src(value: string) {
          sources.push(value);
        }
        decode = decode;
      },
    );
    vi.stubGlobal("fetch", async () => Response.json({}));
    return sources;
  }

  it("plays the full-size animation once it has decoded, keeping the poster until then", async () => {
    const decoded = deferred();
    const sources = preloads(() => decoded.promise);
    const { result } = renderHook(() =>
      useAvatarAnimation(descriptor, community),
    );
    // The relay's thumbnail is only the first frame.
    const full = `/api/relay/${encodeURIComponent(community)}/media?url=${encodeURIComponent(animation)}`;
    await waitFor(() => expect(sources).toEqual([full]));
    expect(result.current).toBeUndefined();
    await act(async () => {
      decoded.resolve();
      await decoded.promise;
    });
    expect(result.current).toBe(full);
  });

  /** The system's reduced-motion setting, changeable while mounted. */
  function motionSetting(reduced: boolean) {
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        listeners.delete(listener),
    }));
    return (next: boolean) =>
      act(() => {
        reduced = next;
        for (const listener of listeners) listener();
      });
  }

  it("never fetches the animation under reduced motion, and follows the setting live", async () => {
    const setReduced = motionSetting(true);
    const sources = preloads(() => Promise.resolve());
    const { result } = renderHook(() =>
      useAvatarAnimation(descriptor, community),
    );
    await act(async () => {});
    expect(sources).toEqual([]);
    setReduced(false);
    await waitFor(() => expect(result.current).toBe(sources[0]));
    setReduced(true);
    expect(result.current).toBeUndefined();
  });

  it("keeps the poster after a failed decode, then plays once a recovered connection serves it", async () => {
    let fail = true;
    const sources = preloads(() =>
      fail ? Promise.reject(new Error("Unavailable")) : Promise.resolve(),
    );
    const { result } = renderHook(() =>
      useAvatarAnimation(descriptor, community),
    );
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {});
    expect(result.current).toBeUndefined();
    fail = false;
    act(() => retryFailedImages());
    await waitFor(() => expect(result.current).toBe(sources[0]));
    expect(sources).toHaveLength(2);
  });

  it("never starts a second request while one is pending, and retries at once if a recovery came during it", async () => {
    const attempts: {
      promise: Promise<void>;
      resolve: () => void;
      reject: (reason: Error) => void;
    }[] = [];
    const sources = preloads(() => {
      let resolve!: () => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      attempts.push({ promise, resolve, reject });
      return promise;
    });
    const { result } = renderHook(() =>
      useAvatarAnimation(descriptor, community),
    );
    await waitFor(() => expect(sources).toHaveLength(1));
    act(() => retryFailedImages());
    expect(sources).toHaveLength(1);
    await act(async () => {
      attempts[0]?.reject(new Error("Unavailable"));
      await attempts[0]?.promise.catch(() => {});
    });
    await waitFor(() => expect(sources).toHaveLength(2));
    await act(async () => {
      attempts[1]?.resolve();
      await attempts[1]?.promise;
    });
    expect(result.current).toBe(sources[0]);
  });

  it("plays in a waiting mount as soon as another mount of the same animation loads it", async () => {
    let calls = 0;
    const sources = preloads(() =>
      calls++ === 0
        ? Promise.reject(new Error("Unavailable"))
        : Promise.resolve(),
    );
    const card = renderHook(() => useAvatarAnimation(descriptor, community));
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {});
    expect(card.result.current).toBeUndefined();
    // Long before the card's own 2 s retry.
    const details = renderHook(() => useAvatarAnimation(descriptor, community));
    await waitFor(() => expect(details.result.current).toBe(sources[0]));
    await waitFor(() => expect(card.result.current).toBe(sources[0]));
  });

  it("makes no request after unmounting, even with a retry scheduled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const sources = preloads(() => Promise.reject(new Error("Unavailable")));
      const { unmount } = renderHook(() =>
        useAvatarAnimation(descriptor, community),
      );
      await waitFor(() => expect(sources).toHaveLength(1));
      await act(async () => {});
      unmount();
      act(() => retryFailedImages());
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(sources).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed decode on the mounted-image schedule", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let failures = 2;
      const sources = preloads(() =>
        failures-- > 0
          ? Promise.reject(new Error("Unavailable"))
          : Promise.resolve(),
      );
      const { result } = renderHook(() =>
        useAvatarAnimation(descriptor, community),
      );
      await waitFor(() => expect(sources).toHaveLength(1));
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(sources).toHaveLength(2);
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      await waitFor(() => expect(result.current).toBe(sources[0]));
      expect(sources).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
