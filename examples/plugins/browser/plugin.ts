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

export async function apply(ctx: Context) {
  const browser = ctx.get("browser", false);
  if (!browser || typeof browser.View !== "function") {
    throw new Error(
      "Browser plugin requires a Buzz build with the embedded browser capability",
    );
  }
  await ctx.inject(["browser"], registerPanel).await();
}

function registerPanel(ctx: Context) {
  const React = ctx.react;
  const BrowserView = ctx.browser.View;

  ctx.panels.register({
    id: "open-link",
    title: "Browser",
    matches: (url) => isBrowsableUrl(url) && ctx.browser.available,
    component: function BrowserPanel({ target }: { target: string }) {
      return React.createElement(BrowserView, { url: target });
    },
  });
}
