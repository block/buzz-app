// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarSectionEmojiInput } from "./SidebarSectionEmojiInput";

vi.mock("../emoji/EmojiPicker", () => ({ EmojiPicker: () => null }));

const catalog = { status: "ready" as const, entries: [], mine: [] };
const session = {
  emoji: {
    snapshot: () => catalog,
    subscribe: () => () => {},
    ensure: vi.fn(async () => {}),
    refresh: async () => {},
  },
  media: (url: string) => url,
};
function field(icon = "❗") {
  return (
    <SidebarSectionEmojiInput
      icon={icon}
      session={session}
      scope="https://relay.example.org:viewer"
      onIconChange={vi.fn()}
    >
      <input aria-label="Section name" />
    </SidebarSectionEmojiInput>
  );
}
function text() {
  const node = document.querySelector<HTMLElement>(
    "[data-sidebar-group-icon] > span",
  );
  if (!node) throw new Error("Native section emoji missing");
  return node;
}

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
let sheet: HTMLStyleElement;
let resize: () => void;
let disconnect: ReturnType<typeof vi.fn>;
let fonts: EventTarget & { ready: Promise<void> };
let fontsReady: () => void;
let queries: MediaQueryList[];
let inkShift: number;
let context: {
  font: string;
  letterSpacing: string;
  scale: ReturnType<typeof vi.fn>;
  measureText: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  session.emoji.ensure.mockClear();
  sheet = document.createElement("style");
  sheet.textContent =
    "span { font: normal 400 16px sans-serif; letter-spacing: 0px; }";
  document.head.append(sheet);
  inkShift = -2;
  context = {
    font: "",
    letterSpacing: "",
    scale: vi.fn(),
    measureText: vi.fn(() => ({ width: 16 })),
    fillText: vi.fn(),
    getImageData: vi.fn((_x, _y, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      const shift = inkShift * window.devicePixelRatio;
      for (let x = width / 2 - 4 + shift; x < width / 2 + 4 + shift; x++) {
        data[(10 * width + x) * 4 + 3] = 255;
      }
      return { data };
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  queries = [];
  vi.stubGlobal("matchMedia", (media: string) => {
    const query = Object.assign(new EventTarget(), { media }) as MediaQueryList;
    queries.push(query);
    return query;
  });
  vi.stubGlobal("devicePixelRatio", 1);
  fonts = Object.assign(new EventTarget(), {
    ready: new Promise<void>((resolve) => {
      fontsReady = resolve;
    }),
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fonts,
  });
});

afterEach(() => {
  cleanup();
  sheet.remove();
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("centers measured ink while retaining decorative Unicode and the trigger's label", () => {
  render(field());
  expect(text()).toHaveTextContent("❗");
  expect(text().style.transform).toBe("translateX(2px)");
  expect(text().parentElement).toHaveAttribute("aria-hidden", "true");
  expect(screen.getByRole("button")).toHaveAccessibleName(
    "Change section emoji, currently ❗",
  );
  expect(context.fillText).toHaveBeenCalledWith("❗", 24, 32);
  expect(session.emoji.ensure).not.toHaveBeenCalled();
});

it("remeasures selection, loaded fonts, text scaling and display density, and cleans up", async () => {
  const view = render(field());
  inkShift = 1;
  view.rerender(field("🚌"));
  expect(text().style.transform).toBe("translateX(-1px)");
  expect(disconnect).toHaveBeenCalledTimes(1);
  inkShift = -1;
  await act(async () => {
    fontsReady();
    await fonts.ready;
  });
  expect(text().style.transform).toBe("translateX(1px)");
  inkShift = -3;
  act(() => fonts.dispatchEvent(new Event("loadingdone")));
  expect(text().style.transform).toBe("translateX(3px)");
  const measured = context.fillText.mock.calls.length;
  act(() => resize());
  expect(context.fillText).toHaveBeenCalledTimes(measured);
  sheet.textContent =
    "span { font: normal 400 24px sans-serif; letter-spacing: 0px; }";
  act(() => resize());
  expect(context.fillText).toHaveBeenLastCalledWith("🚌", 32, 48);
  vi.stubGlobal("devicePixelRatio", 2);
  act(() => queries.at(-1)?.dispatchEvent(new Event("change")));
  expect(context.scale).toHaveBeenLastCalledWith(2, 2);
  expect(queries.at(-1)?.media).toBe("(resolution: 2dppx)");
  expect(text().style.transform).toBe("translateX(3px)");
  view.unmount();
  const finished = context.fillText.mock.calls.length;
  act(() => {
    resize();
    window.dispatchEvent(new Event("resize"));
    fonts.dispatchEvent(new Event("loadingdone"));
    queries.at(-1)?.dispatchEvent(new Event("change"));
  });
  expect(context.fillText).toHaveBeenCalledTimes(finished);
  expect(disconnect).toHaveBeenCalledTimes(2);
});

it.each([":stamp:", ""])(
  "does not probe community artwork or the empty placeholder (%s)",
  (icon) => {
    render(field(icon));
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toHaveAccessibleName(
      icon ? "Change section emoji, currently stamp" : "Choose section emoji",
    );
  },
);

it.each(["context", "pixels", "empty", "oversized"])(
  "keeps grid centering when the probe is unavailable (%s)",
  (failure) => {
    if (failure === "context")
      vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    if (failure === "pixels")
      context.getImageData.mockImplementation(() => {
        throw new Error("Unavailable");
      });
    if (failure === "empty")
      context.getImageData.mockImplementation(() => ({
        data: new Uint8ClampedArray(),
      }));
    if (failure === "oversized")
      context.measureText.mockReturnValue({ width: 100_000 });
    render(field());
    expect(text()).toHaveTextContent("❗");
    expect(text().style.transform).toBe("translateX(0px)");
    if (failure === "oversized")
      expect(context.getImageData).not.toHaveBeenCalled();
  },
);

it("ignores a font-ready callback after the control unmounts", async () => {
  const view = render(field());
  view.unmount();
  const measured = context.fillText.mock.calls.length;
  await act(async () => {
    fontsReady();
    await fonts.ready;
  });
  expect(context.fillText).toHaveBeenCalledTimes(measured);
});
