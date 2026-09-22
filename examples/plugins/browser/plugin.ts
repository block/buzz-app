import type { Context } from "@buzz/author";

// Type-only author contract. The installed artifact has no private paths, React
// copy, or runtime dependencies beyond what the host injects.
export const inject = ["react", "panels"];

const MAX_URL_BYTES = 2048;

/** http(s) only: rejects javascript:, data:, file:, and malformed input. */
export function isBrowsableUrl(url: string): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      new TextEncoder().encode(parsed.toString()).byteLength <= MAX_URL_BYTES
    );
  } catch {
    return false;
  }
}

export type BrowseState =
  | { status: "loading" }
  | { status: "opened" }
  | { status: "failed"; reason: string };

export async function apply(ctx: Context) {
  if (!ctx.get("browser", false)) {
    throw new Error(
      "Browser plugin requires a Buzz build with the browser capability",
    );
  }
  await ctx.inject(["browser"], registerPanel).await();
}

function registerPanel(ctx: Context) {
  const React = ctx.react;

  ctx.panels.register({
    id: "open-link",
    title: "Browser",
    // Only claims a link when the host's browser capability is actually
    // available on this platform. Where it isn't, matches() returns false
    // and http(s) links fall through to the host's existing handling
    // exactly as before this plugin was installed.
    matches: (url) => isBrowsableUrl(url) && ctx.browser.available,
    component: function BrowserPanel({
      target,
      close,
    }: {
      target: string;
      close(): void;
    }) {
      const [state, setState] = React.useState<BrowseState>({
        status: "loading",
      });
      // Persists across a StrictMode dev double-invoke of this effect, so
      // ctx.browser.open() is launched exactly once per distinct target.
      // Every effect instance still attaches its OWN completion observer to
      // that one shared promise — the first (StrictMode-cleaned-up)
      // instance's observer no-ops via its own `disposed`, but the
      // surviving instance's observer still applies the result. Skipping
      // attachment on the second instance would strand the result forever,
      // since the first instance's cleanup already disposed by the time the
      // promise resolves.
      const inFlight = React.useRef<
        | {
            target: string;
            promise: Promise<Awaited<ReturnType<typeof ctx.browser.open>>>;
          }
        | undefined
      >(undefined);
      React.useEffect(() => {
        let disposed = false;
        if (inFlight.current?.target !== target) {
          setState({ status: "loading" });
          inFlight.current = { target, promise: ctx.browser.open(target) };
        }
        inFlight.current.promise.then(
          (result) => {
            if (disposed) return;
            setState(
              result.status === "opened"
                ? { status: "opened" }
                : {
                    status: "failed",
                    reason: "reason" in result ? result.reason : result.status,
                  },
            );
          },
          () => {
            if (!disposed) setState({ status: "failed", reason: "host-error" });
          },
        );
        return () => {
          disposed = true;
        };
      }, [target]);

      return React.createElement(
        "section",
        {
          "aria-label": "Browser",
          style: {
            display: "flex",
            flexDirection: "column",
            gap: 12,
            padding: 16,
          },
        },
        React.createElement(
          "div",
          {
            role: "toolbar",
            "aria-label": "Address",
            style: { display: "flex", gap: 8 },
          },
          React.createElement("input", {
            readOnly: true,
            value: target,
            "aria-label": "Address",
            style: { flex: 1, padding: 6 },
          }),
          React.createElement(
            "button",
            { type: "button", onClick: close },
            "Close",
          ),
        ),
        state.status === "loading" &&
          React.createElement("p", { role: "status" }, "Opening…"),
        state.status === "opened" &&
          React.createElement("p", { role: "status" }, "Opened."),
        state.status === "failed" &&
          React.createElement(
            "p",
            { role: "alert" },
            `Couldn't open this link (${state.reason}).`,
          ),
      );
    },
  });
}
