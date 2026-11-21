// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditableInput } from "../features/messages/EditableInput";
import { composerDOMFixture } from "../features/messages/composer-testing";
import type { ComposerInputElement } from "../features/messages/composer-dom";
import { mentionDraft } from "../features/messages/mention-draft";
import { createNavigationController } from "../features/navigation/controller";
import { createMemoryHistory } from "../features/navigation/history";
import { createShortcutBindings } from "../features/shortcuts/preferences";
import { ShortcutsService } from "../features/shortcuts/service";
import { registerNavigationShortcuts } from "./shortcuts";

composerDOMFixture();
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function harness(platform = "MacIntel") {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const bindings = createShortcutBindings(window);
  const shortcuts = new ShortcutsService(ctx, window, bindings);
  const controller = createNavigationController(createMemoryHistory());
  const navigation = controller.navigation;
  const remove = registerNavigationShortcuts(shortcuts, navigation);
  void navigation.open({ version: 1, kind: "home" });
  void navigation.open({ version: 1, kind: "settings" });
  void navigation.open({ version: 1, kind: "home" });
  navigation.back();
  await vi.waitFor(() =>
    expect(navigation.snapshot()).toMatchObject({
      canGoBack: true,
      canGoForward: true,
    }),
  );
  return {
    navigation,
    bindings,
    shortcuts,
    target: () => navigation.snapshot().attempt.entry.target.kind,
    async dispose() {
      remove();
      controller.dispose();
      bindings.dispose();
      await ctx.fiber.dispose();
    },
  };
}

function press(
  target: HTMLElement,
  key: string,
  extra: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...extra,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function composer(value = "") {
  const ref = createRef<ComposerInputElement>();
  render(
    <EditableInput
      ref={ref}
      isEmptyForShortcuts={() => ref.current?.value === ""}
      draft={mentionDraft(value)}
      value={value}
      decorationsFor={() => []}
      onDraftChange={() => {}}
      onFormatsChange={() => {}}
      disabled={false}
      placeholder="Draft"
      maxLength={16000}
    />,
  );
  const input = screen.getByRole("textbox", {
    name: "Draft",
  }) as ComposerInputElement;
  act(() => {
    input.focus();
  });
  return input;
}

it("navigates repeatedly from the focused empty composer and retains bracket shortcuts", async () => {
  const h = await harness();
  const input = composer();
  try {
    for (const [back, forward] of [
      ["ArrowLeft", "ArrowRight"],
      ["[", "]"],
    ] as const) {
      expect(press(input, back).defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(h.target()).toBe("home"));
      expect(input).toHaveFocus();
      expect(press(input, forward).defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(h.target()).toBe("settings"));
    }
  } finally {
    await h.dispose();
  }
});

it.each(["draft", " ", "\n", "@person"])(
  "keeps arrow keys in a composer containing %j, then navigates after clearing",
  async (value) => {
    const h = await harness();
    const input = composer(value);
    try {
      for (const key of ["ArrowLeft", "ArrowRight"]) {
        press(input, key);
        await act(async () => {});
        expect(h.target()).toBe("settings");
        expect(input.value).toBe(value);
      }
      act(() => {
        input.value = "";
      });
      press(input, "ArrowLeft");
      await vi.waitFor(() => expect(h.target()).toBe("home"));
    } finally {
      await h.dispose();
    }
  },
);

it.each(["input", "textarea", "contenteditable"])(
  "preserves editing keys in an empty %s",
  async (kind) => {
    const h = await harness();
    const input = document.createElement(
      kind === "contenteditable" ? "div" : kind,
    );
    if (kind === "contenteditable") {
      input.contentEditable = "true";
      input.setAttribute("role", "textbox");
    }
    document.body.append(input);
    input.focus();
    try {
      expect(press(input, "ArrowLeft").defaultPrevented).toBe(false);
      await act(async () => {});
      expect(h.target()).toBe("settings");
      expect(press(input, "[").defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(h.target()).toBe("home"));
    } finally {
      await h.dispose();
    }
  },
);

it("respects rebindings, composition, modifiers, and repeat guards", async () => {
  const h = await harness();
  const input = composer();
  try {
    for (const extra of [
      { isComposing: true },
      { keyCode: 229 },
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true },
      { repeat: true },
    ]) {
      press(input, "ArrowLeft", extra);
      await act(async () => {});
      expect(h.target()).toBe("settings");
    }
    h.bindings.set("navigation-back", { key: "u", mod: true });
    press(input, "ArrowLeft");
    await act(async () => {});
    expect(h.target()).toBe("settings");
    press(input, "u");
    await vi.waitFor(() => expect(h.target()).toBe("home"));
  } finally {
    await h.dispose();
  }
});

it.each(["Win32", "Linux x86_64"])(
  "preserves the existing defaults on %s",
  async (platform) => {
    const h = await harness(platform);
    try {
      expect(
        press(document.body, "ArrowLeft", { metaKey: false, ctrlKey: true })
          .defaultPrevented,
      ).toBe(false);
      expect(
        press(document.body, "[", { metaKey: false, ctrlKey: true })
          .defaultPrevented,
      ).toBe(true);
      await vi.waitFor(() => expect(h.target()).toBe("home"));
    } finally {
      await h.dispose();
    }
  },
);

it("keeps non-keyboard history navigation available while a draft is focused", async () => {
  const h = await harness();
  const input = composer("draft");
  try {
    expect(h.shortcuts.runHost("navigation-back")).toBe(true);
    await vi.waitFor(() => expect(h.target()).toBe("home"));
    expect(h.shortcuts.runHost("navigation-forward")).toBe(true);
    await vi.waitFor(() => expect(h.target()).toBe("settings"));
    expect(input.value).toBe("draft");
  } finally {
    await h.dispose();
  }
});

it.each(
  [
    { shift: true, shiftKey: true },
    { alt: true, altKey: true },
    { ctrl: true, ctrlKey: true },
  ].flatMap((modifiers) =>
    ["input", "composer"].map((target) => ({ modifiers, target })),
  ),
)(
  "preserves modified-arrow rebindings in an editable: %j",
  async ({ modifiers, target }) => {
    const h = await harness();
    const input =
      target === "composer"
        ? composer("draft")
        : document.createElement("input");
    if (target === "input") document.body.append(input);
    input.focus();
    try {
      h.bindings.set("navigation-back", {
        key: "ArrowLeft",
        mod: true,
        ...modifiers,
      });
      expect(press(input, "ArrowLeft", modifiers).defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(h.target()).toBe("home"));
    } finally {
      await h.dispose();
    }
  },
);

it.each(["composer", "body"])(
  "normalizes WebKit Command arrows from %s",
  async (target) => {
    const h = await harness();
    const input = target === "composer" ? composer() : document.body;
    try {
      expect(
        press(input, "\u001c", { code: "ArrowLeft", keyCode: 37 })
          .defaultPrevented,
      ).toBe(true);
      await vi.waitFor(() => expect(h.target()).toBe("home"));
      expect(
        press(input, "\u001d", { code: "ArrowRight", keyCode: 39 })
          .defaultPrevented,
      ).toBe(true);
      await vi.waitFor(() => expect(h.target()).toBe("settings"));
    } finally {
      await h.dispose();
    }
  },
);
