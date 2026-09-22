import { Context, Service } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";
import { apply, inject, isBrowsableUrl } from "./plugin.ts";

const manifest = {
  name: "Browser",
  inject,
  apply,
};

class TestPanels extends Service {
  registrationCount = 0;

  constructor(ctx: Context) {
    super(ctx, "panels");
  }

  register() {
    this.ctx.effect(() => {
      this.registrationCount++;
      return () => {
        this.registrationCount--;
      };
    });
  }
}

function hostWithoutBrowser() {
  const root = new Context();
  root.provide("react", {});
  const panels = new TestPanels(root);
  return { root, panels };
}

it("fails immediately with a matching-host diagnostic when browser is absent", async () => {
  const { root } = hostWithoutBrowser();
  try {
    const plugin = root.plugin(manifest);
    await expect(plugin.await()).rejects.toThrow(
      "Browser plugin requires a Buzz build with the browser capability",
    );
  } finally {
    await root.fiber.dispose();
  }
});

it("waits for a present provider to activate and tracks its withdrawal", async () => {
  const { root, panels } = hostWithoutBrowser();
  let browserDependency: ReturnType<Context["plugin"]> | undefined;
  let allowActivation: (() => void) | undefined;
  const removeObserver = root.on("internal/plugin", (fiber) => {
    if (fiber.name === "registerPanel") browserDependency = fiber;
  });
  try {
    let reportProvided!: () => void;
    const provided = new Promise<void>((resolve) => {
      reportProvided = resolve;
    });
    const activationAllowed = new Promise<void>((resolve) => {
      allowActivation = resolve;
    });
    const provider = root.plugin({
      name: "browser-provider",
      async apply(ctx) {
        ctx.provide("browser", { available: true, open: vi.fn() });
        reportProvided();
        await activationAllowed;
      },
    });
    await provided;
    const plugin = root.plugin(manifest);
    await vi.waitFor(() => expect(browserDependency).toBeDefined());
    await plugin.await();
    expect(panels.registrationCount).toBe(0);
    allowActivation?.();
    await provider.await();
    await browserDependency?.await();
    expect(panels.registrationCount).toBe(1);
    await provider.dispose();
    expect(panels.registrationCount).toBe(0);
  } finally {
    allowActivation?.();
    removeObserver();
    await root.fiber.dispose();
  }
});

describe("isBrowsableUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isBrowsableUrl("https://example.com")).toBe(true);
    expect(isBrowsableUrl("http://example.com/path?q=1")).toBe(true);
  });

  it("rejects non-http(s) schemes", () => {
    expect(isBrowsableUrl("javascript:alert(1)")).toBe(false);
    expect(isBrowsableUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isBrowsableUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects malformed or empty input", () => {
    expect(isBrowsableUrl("")).toBe(false);
    expect(isBrowsableUrl("not a url")).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: exercising non-string input at the boundary
    expect(isBrowsableUrl(null as any)).toBe(false);
  });

  it("rejects excessively long input", () => {
    expect(isBrowsableUrl(`https://example.com/${"a".repeat(3000)}`)).toBe(
      false,
    );
  });

  it("rejects embedded credentials and measures the normalized URL", () => {
    expect(isBrowsableUrl("https://user:password@example.com")).toBe(false);
    expect(isBrowsableUrl(`https://example.com/${"文".repeat(300)}`)).toBe(
      false,
    );
    expect(isBrowsableUrl(`https://example.com/${"文".repeat(50)}`)).toBe(true);
  });
});
