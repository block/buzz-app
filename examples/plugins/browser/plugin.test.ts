import { describe, expect, it } from "vitest";
import { isBrowsableUrl } from "./plugin.ts";

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
