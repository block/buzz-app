// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { onboardingTransition } from "./onboarding-transition";

const LINUX_WEBKITGTK =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const MAC_WEBKIT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const startViewTransition = vi.fn((callback: () => void) => {
  callback();
  return { finished: Promise.resolve() } as ViewTransition;
});

function platform(name: string, userAgent: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(name);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

beforeEach(() => {
  document.body.innerHTML = "<main></main>";
  document.startViewTransition =
    startViewTransition as unknown as Document["startViewTransition"];
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  startViewTransition.mockClear();
  delete document.documentElement.dataset.onboardingDirection;
  Reflect.deleteProperty(document, "startViewTransition");
});

it("updates without a view transition on Linux, where WebKitGTK can crash", () => {
  platform("Linux x86_64", LINUX_WEBKITGTK);
  const update = vi.fn();

  onboardingTransition(update);

  expect(update).toHaveBeenCalledOnce();
  expect(startViewTransition).not.toHaveBeenCalled();
  expect(document.documentElement.dataset.onboardingDirection).toBeUndefined();
  expect(
    document
      .querySelector("main")
      ?.style.getPropertyValue("view-transition-name"),
  ).toBe("");
});

it.each([
  ["macOS", "MacIntel", MAC_WEBKIT],
  ["Android", "Linux armv8l", ANDROID],
])("keeps the view transition on %s", async (_, name, userAgent) => {
  platform(name, userAgent);
  const update = vi.fn();

  onboardingTransition(update);

  expect(startViewTransition).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(
      document.documentElement.dataset.onboardingDirection,
    ).toBeUndefined(),
  );
});
