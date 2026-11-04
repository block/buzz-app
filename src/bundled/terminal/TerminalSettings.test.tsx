// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  createTerminalFontPreference,
  TERMINAL_FONT_KEY,
  type TerminalFontPreference,
} from "./font-preference";
import { TerminalSettings } from "./TerminalSettings";

const stores: TerminalFontPreference[] = [];
const loadFont = vi.fn<(font: string) => Promise<FontFace[]>>();
const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
beforeEach(() => {
  loadFont.mockReset().mockResolvedValue([]);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: loadFont },
  });
  // Fake only layout measurements; React and the font-check lifecycle stay real.
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.style.visibility !== "hidden" || this.style.fontSize !== "32px")
        return measure.call(this);
      const font = this.style.font;
      return {
        width:
          font.includes(",") && !font.includes('"ASDF"')
            ? 300
            : font.endsWith("monospace")
              ? 100
              : 200,
      } as DOMRect;
    },
  );
});
function setup() {
  const font = createTerminalFontPreference();
  stores.push(font);
  const content = (active = true) => (
    <StrictMode>
      <ToastProvider>
        <TerminalSettings font={font} active={() => active} />
      </ToastProvider>
    </StrictMode>
  );
  return { font, content, view: render(content()) };
}
afterEach(() => {
  cleanup();
  for (const font of stores.splice(0)) font.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (fontsDescriptor)
    Object.defineProperty(document, "fonts", fontsDescriptor);
  else Reflect.deleteProperty(document, "fonts");
  localStorage.clear();
});

it("blocks Apply during checking and on failure, then retries without changing the active font", async () => {
  let finish: (() => void) | undefined;
  loadFont.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  const { font } = setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  fireEvent.change(input, { target: { value: "ASDF" } });
  expect(loadFont).toHaveBeenCalled();
  expect(input).toHaveAttribute("aria-busy", "true");
  expect(input).toHaveAccessibleDescription(
    /Type an installed font family name/,
  );
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  const form = input.closest("form");
  if (!form) throw new Error("Missing font form");
  fireEvent.submit(form);
  expect(font.snapshot().family).toBeNull();
  await act(async () => finish?.());
  expect(input).toHaveAccessibleDescription(/Couldn’t load “ASDF”/);
  fireEvent.submit(form);
  expect(font.snapshot().family).toBeNull();
  loadFont.mockResolvedValue([]);
  // A fresh name can be checked successfully after the unavailable choice.
  fireEvent.change(input, { target: { value: "MesloLGS NF" } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled(),
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot().family).toBe("MesloLGS NF");
});

it("ignores a stale success and recovers from probe rejection with Retry", async () => {
  let finishOld: (() => void) | undefined;
  loadFont.mockImplementation((name) =>
    name.includes("Old Font")
      ? new Promise((resolve) => {
          finishOld = () => resolve([]);
        })
      : Promise.reject(new Error("Font access failed")),
  );
  setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  fireEvent.change(input, { target: { value: "Old Font" } });
  fireEvent.change(input, { target: { value: "New Font" } });
  fireEvent.blur(input);
  await screen.findByText(/Couldn’t load “New Font”/);
  await act(async () => finishOld?.());
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  loadFont.mockResolvedValue([]);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Retry font check" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled(),
  );
  expect(input).toHaveFocus();
});

it("reports an unavailable saved font without clearing it, and allows Use default", async () => {
  localStorage.setItem(TERMINAL_FONT_KEY, "ASDF");
  const { font } = setup();
  expect(await screen.findByRole("status")).toHaveTextContent(
    "The terminal is using JetBrains Mono",
  );
  expect(font.snapshot().family).toBe("ASDF");
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  fireEvent.change(screen.getByRole("spinbutton", { name: "Font size (px)" }), {
    target: { value: "20" },
  });
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot()).toMatchObject({ family: "ASDF", size: 20 });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Use default" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
});

it("removes its measurement element after checking CSS font resolution", async () => {
  const { canLoadFont } = await import("./font-availability");
  const before = document.querySelectorAll("span").length;
  expect(await canLoadFont("MesloLGS NF")).toBe(true);
  expect(await canLoadFont("ASDF")).toBe(false);
  expect(document.querySelectorAll("span").length).toBe(before);
});

it("previews and applies size alone with the default family, then resets both", async () => {
  const { font } = setup();
  const input = screen.getByRole("spinbutton", { name: "Font size (px)" });
  expect(input).toHaveValue(12);
  fireEvent.change(input, { target: { value: "17.5" } });
  expect(screen.getByText(/^Preview:/)).toHaveStyle({
    fontSize: "17.5px",
    letterSpacing: "0",
  });
  expect(font.snapshot().size).toBe(12);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot()).toEqual({ family: null, size: 17.5, error: null });
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Use default" }));
  expect(input).toHaveValue(12);
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
});

it("blocks invalid size submissions and preserves an edited size across external changes", async () => {
  const { font } = setup();
  const input = screen.getByRole("spinbutton", { name: "Font size (px)" });
  for (const value of ["", "7", "33"]) {
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    const form = input.closest("form");
    if (!form) throw new Error("Missing font form");
    fireEvent.submit(form);
    expect(font.snapshot().size).toBe(12);
  }
  fireEvent.change(input, { target: { value: "16" } });
  act(() => font.set("MesloLGS NF", 20));
  expect(input).toHaveValue(16);
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot()).toEqual({
    family: "MesloLGS NF",
    size: 16,
    error: null,
  });
});

it("retries a failed restore without deleting the saved font", async () => {
  localStorage.setItem(TERMINAL_FONT_KEY, "MesloLGS NF");
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Read unavailable");
  });
  const remove = vi.spyOn(Storage.prototype, "removeItem");
  const { font } = setup();
  const user = userEvent.setup();
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "could not be restored",
  );
  // Establish the real control to which toast focus should return.
  await user.click(screen.getByRole("textbox", { name: "Font family" }));
  await user.click(screen.getByRole("button", { name: /Retry/ }));
  expect(remove).not.toHaveBeenCalled();
  expect(font.snapshot().error).toContain("could not be restored");
  read.mockRestore();
  await user.click(screen.getByRole("button", { name: /Retry/ }));
  expect(font.snapshot()).toEqual({
    family: "MesloLGS NF",
    size: 12,
    error: null,
  });
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBe("MesloLGS NF");
  expect(screen.getByRole("textbox", { name: "Font family" })).toHaveValue(
    "MesloLGS NF",
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("shows the saved family and previews a draft without applying it until Apply", async () => {
  localStorage.setItem(TERMINAL_FONT_KEY, "MesloLGS NF");
  const { font } = setup();
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  expect(input).toHaveValue("MesloLGS NF");
  expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  await user.clear(input);
  await user.type(input, "  JetBrainsMono Nerd Font Mono  ");
  expect(font.snapshot().family).toBe("MesloLGS NF");
  expect(screen.getByText(/^Preview:/)).toHaveStyle({
    fontFamily: '"JetBrainsMono Nerd Font Mono", var(--font-system-mono)',
  });
  expect(screen.getByText(/^Preview:/)).toHaveTextContent(
    /^Preview: ABC 0123$/,
  );
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot().family).toBe("JetBrainsMono Nerd Font Mono");
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBe(
    "JetBrainsMono Nerd Font Mono",
  );
  expect(input).toHaveValue("JetBrainsMono Nerd Font Mono");
  await user.click(screen.getByRole("button", { name: "Use default" }));
  expect(input).toHaveValue("");
  expect(font.snapshot().family).toBeNull();
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("rejects invalid drafts even on form submission and clears invalid input with Use default", async () => {
  const { font } = setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  for (const value of ["A,B", '"A"', "A;B", "a".repeat(65), ""]) {
    fireEvent.change(input, { target: { value: value || " " } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/Enter one font family name/);
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    const form = input.closest("form");
    if (!form) throw new Error("Missing font form");
    fireEvent.submit(form);
    expect(font.snapshot().family).toBeNull();
    expect(screen.getByText(/^Preview:/)).toHaveStyle({
      fontFamily: "var(--font-system-mono)",
    });
  }
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Use default" }));
  expect(input).toHaveValue("");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("follows saved changes while clean and retains an edited draft until Apply", async () => {
  const { font } = setup();
  const input = screen.getByRole("textbox", { name: "Font family" });
  act(() => font.set("MesloLGS NF"));
  expect(input).toHaveValue("MesloLGS NF");
  fireEvent.change(input, { target: { value: "Courier New" } });
  act(() => font.set("Other Font"));
  expect(input).toHaveValue("Courier New");
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot().family).toBe("Courier New");
});

it("keeps failed saves active, hides recovery while inactive, and retries the active preference", async () => {
  const { font, content, view } = setup();
  const user = userEvent.setup();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Unavailable");
    });
  await user.type(
    screen.getByRole("textbox", { name: "Font family" }),
    "MesloLGS NF",
  );
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(font.snapshot().family).toBe("MesloLGS NF");
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "could not be saved",
  );
  view.rerender(content(false));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  view.rerender(content(true));
  write.mockRestore();
  await user.click(
    await screen.findByRole("button", {
      name: "Retry terminal font preference",
    }),
  );
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBe("MesloLGS NF");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

it("explains failed reset persistence and retries removal of the old preference", async () => {
  localStorage.setItem(TERMINAL_FONT_KEY, "MesloLGS NF");
  const { font } = setup();
  const user = userEvent.setup();
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("Unavailable");
    });
  await user.click(screen.getByRole("button", { name: "Use default" }));
  expect(font.snapshot().family).toBeNull();
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Your previous font may return after restarting",
  );
  remove.mockRestore();
  await user.click(
    screen.getByRole("button", { name: "Retry terminal font preference" }),
  );
  expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBeNull();
  expect(font.snapshot().error).toBeNull();
});
