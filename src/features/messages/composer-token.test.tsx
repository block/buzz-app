// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState, type ComponentType, type ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { EditableInput } from "./EditableInput";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";
import { composerClipboard } from "./composer-clipboard";
import {
  composerChips,
  readComposerDocument,
  readComposerSnapshot,
} from "./composer-document";
import {
  composerToken,
  composerTokenName,
  type ComposerToken,
} from "./composer-token";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import { TaskSkillDetailsContext } from "./selected-mention-context";

composerDOMFixture();
afterEach(cleanup);

const folder: ComposerToken = {
  kind: "nexus.folder",
  id: "/Development/notes",
  label: "@notes",
  executionHost: "82e43596-21a8-43c2-afb3-a9d8f2b4bf85",
};

it("bounds token JSON by UTF-8 bytes, including multibyte identities", () => {
  const template = { kind: "nexus.folder", id: "", label: "Folder" };
  const overhead = new TextEncoder().encode(JSON.stringify(template)).length;
  const count = Math.floor((8192 - overhead) / 3);
  const fitting = { ...template, id: "界".repeat(count) };
  expect(composerToken(fitting)).toEqual(fitting);
  expect(composerToken({ ...fitting, id: `${fitting.id}界` })).toBeUndefined();
});

it("copies a bounded, frozen token of a known kind and nothing else", () => {
  const nested = { ...folder, extra: { preserve: true } };
  const copied = composerToken(nested);
  expect(copied).toEqual(nested);
  expect(copied).not.toBe(nested);
  expect(Object.isFrozen(copied)).toBe(true);
  expect(Object.isFrozen(copied?.extra)).toBe(true);
  expect(composerTokenName(folder)).toBe("Folder @notes");
  for (const valid of [
    { kind: "nexus.project", id: "p", label: "Project" },
    { kind: "nexus.repository", id: "r", label: "@r", verified: true },
    { kind: "nexus.skill", id: "s", label: "/s", target: "a".repeat(64) },
  ])
    expect(composerToken(valid)).toEqual(valid);
  for (const invalid of [
    { ...folder, id: "" },
    { ...folder, id: "x".repeat(4097) },
    { ...folder, id: "/path\u0000" },
    { ...folder, label: " " },
    { ...folder, label: "x".repeat(257) },
    { ...folder, label: "@\u202enotes" },
    { ...folder, extra: "界".repeat(3000) },
    { ...folder, kind: "nexus.unknown" },
    { kind: "nexus.repository", id: "r", label: "@r" },
    { kind: "nexus.skill", id: "s", label: "/s", target: "bad" },
    [folder],
  ])
    expect(composerToken(invalid)).toBeUndefined();
});

const chips = (draft: MentionDraft) =>
  composerChips(readComposerSnapshot(draft.document));

function mount(
  initial: MentionDraft | string,
  maxLength = 16000,
  wrapper?: ComponentType<{ children: ReactNode }>,
) {
  const ref = createRef<ComposerInputElement>();
  let draft = mentionDraft(initial);
  function Editor() {
    const [value, setValue] = useState(draft);
    return (
      <EditableInput
        ref={ref}
        draft={value}
        value={value.text}
        disabled={false}
        placeholder="Draft"
        maxLength={maxLength}
        decorationsFor={() => []}
        onFormatsChange={() => {}}
        onDraftChange={(next) => {
          draft = next;
          setValue(next);
        }}
      />
    );
  }
  const view = render(<Editor />, {
    reactStrictMode: true,
    ...(wrapper ? { wrapper } : {}),
  });
  const input = ref.current;
  if (!input) throw new Error("Editor did not mount");
  act(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return { input, view, draft: () => draft };
}

it("replaces an open query with one chip: named, separate from recipients, one undo step, and restored from a saved draft", () => {
  const f = mount("Use @no");
  const start = f.input.value.indexOf("@no");
  act(() => {
    expect(f.input.insertToken(folder, { start, end: start + 3 })).toBe(true);
  });
  expect(f.input).toHaveValue("Use @notes ");
  expect(f.input).toHaveFocus();
  expect(f.input.selectionStart).toBe("Use @notes ".length);
  expect(screen.getByRole("img", { name: "Folder @notes" })).toHaveTextContent(
    "@notes",
  );
  expect(chips(f.draft())).toEqual([{ token: folder, start, end: start + 6 }]);
  expect(f.draft().recipients).toEqual([]);
  // Plugins see MentionDraft; chips stay in the host-owned document.
  expect(Object.keys(f.draft()).sort()).toEqual([
    "document",
    "recipients",
    "text",
  ]);
  act(() => f.input.undo(false));
  expect(f.input).toHaveValue("Use @no");
  expect(chips(f.draft())).toEqual([]);
  act(() => f.input.undo(true));
  expect(f.input).toHaveValue("Use @notes ");
  const saved = mentionDraft(JSON.parse(JSON.stringify(f.draft())));
  expect(chips(saved)).toEqual([{ token: folder, start, end: start + 6 }]);
  f.view.unmount();
  const restored = mount(saved);
  expect(restored.input).toHaveValue("Use @notes ");
  expect(
    screen.getByRole("img", { name: "Folder @notes" }),
  ).toBeInTheDocument();
  expect(chips(restored.draft()).map((span) => span.token)).toEqual([folder]);
});

it("refuses a workspace, a stale or literal range, and edits beyond the chip or length bounds", () => {
  const f = mount("`@no` @no", 18);
  const before = f.draft();
  const open = f.input.value.lastIndexOf("@no");
  act(() => {
    expect(
      f.input.insertToken(
        { kind: "nexus.project", id: "p", label: "Project" },
        { start: open, end: open + 3 },
      ),
    ).toBe(false);
    // Inside inline code, the query is literal text.
    expect(f.input.insertToken(folder, { start: 1, end: 4 })).toBe(false);
    expect(
      f.input.insertToken(
        { ...folder, label: "@a-label-too-long-to-fit" },
        { start: open, end: open + 3 },
      ),
    ).toBe(false);
    expect(
      f.input.insertToken(
        { ...folder, id: "" },
        { start: open, end: open + 3 },
      ),
    ).toBe(false);
  });
  expect(f.draft()).toEqual(before);
  const many = mount(" ".repeat(33));
  act(() => {
    for (let i = 0; i < 32; i++)
      expect(
        many.input.insertToken(
          { ...folder, id: `/f${i}`, label: "@f" },
          { start: i * 3, end: i * 3 + 1 },
        ),
      ).toBe(true);
    expect(
      many.input.insertToken(
        { ...folder, id: "/f33", label: "@f" },
        { start: 96, end: 97 },
      ),
    ).toBe(false);
  });
  expect(chips(many.draft())).toHaveLength(32);
});

it("copies a chip as its label text, never as a link its label resembles", () => {
  const link = { ...folder, label: "https://example.com" };
  const f = mount("x");
  act(() => {
    f.input.insertToken(link, { start: 0, end: 1 });
  });
  const clipboard = composerClipboard(
    readComposerDocument(f.draft(), []),
    document,
  );
  expect(clipboard.text).toBe("https://example.com ");
  expect(clipboard.html).not.toContain("<a");
});

it("restores a chip, and marks chip data any snapshot rejection would drop as another build's data", () => {
  const token = (attrs: object, rest: object[] = []) => ({
    text: "@notes",
    recipients: [],
    document: {
      version: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "token", attrs }, ...rest],
          },
        ],
      },
    },
  });
  const valid = mentionDraft(token({ source: "@notes", semantic: folder }));
  expect(chips(valid).map((span) => span.token)).toEqual([folder]);
  expect(valid.unsupported).toBeUndefined();
  for (const attrs of [
    { source: "@notes", semantic: { ...folder, kind: "nexus.unknown" } },
    { source: "@other", semantic: folder },
    {
      source: "@notes",
      semantic: folder,
      recipient: { pubkey: "a".repeat(64), name: "notes" },
    },
    {
      source: "@notes",
      semantic: folder,
      resource: { uri: "buzz://channel/c", label: "@notes" },
    },
    { source: "@notes", semantic: folder, pending: { id: "p", name: "notes" } },
  ]) {
    const draft = mentionDraft(token(attrs));
    expect(chips(draft)).toEqual([]);
    expect(draft.unsupported).toBe(true);
    expect(mentionDraft(JSON.parse(JSON.stringify(draft))).unsupported).toBe(
      true,
    );
  }
  // A supported chip in a snapshot rejected for another reason.
  const rejected = token({ source: "@notes", semantic: folder }, [
    { type: "text" },
  ]);
  expect(mentionDraft(rejected).unsupported).toBe(true);
  // Without chip data, the same rejection still restores the saved text alone.
  expect(mentionDraft(token({ source: "@notes" }, [{ type: "text" }]))).toEqual(
    { text: "@notes", recipients: [] },
  );
});

it("opens a skill chip's details in place by pointer or key, and dismisses only them", async () => {
  const target = "a".repeat(64);
  const skill: ComposerToken = {
    kind: "nexus.skill",
    id: JSON.stringify({
      path: "/Users/me/.claude/skills/review/SKILL.md",
      name: "review",
      source: "~/.claude/skills/review/SKILL.md",
    }),
    label: "review",
    target,
  };
  let details:
    | { description?: string | undefined; location?: string | undefined }
    | undefined = {
    description: "Reviews a diff.",
    location: "~/.claude/skills/review/SKILL.md",
  };
  const lookups: unknown[] = [];
  const f = mount("Use /re", 16000, ({ children }) => (
    <TaskSkillDetailsContext.Provider
      value={(token) => {
        lookups.push(token);
        return details;
      }}
    >
      {children}
    </TaskSkillDetailsContext.Provider>
  ));
  act(() => {
    f.input.insertToken(skill, { start: 4, end: 7 });
  });
  const saved = f.draft();
  const user = userEvent.setup();
  const chip = screen.getByRole("button", { name: "Skill review" });
  expect(lookups).toEqual([]);

  await user.click(chip);
  const dialog = await screen.findByRole("dialog", { name: "review" });
  expect(dialog).toHaveTextContent(
    "reviewReviews a diff.~/.claude/skills/review/SKILL.md",
  );
  expect(lookups.at(-1)).toMatchObject({ id: skill.id, target });
  // No reference, recipient or verification internals.
  for (const hidden of [skill.id, target, "/Users/me", "reported", "reference"])
    expect(document.body.textContent).not.toContain(hidden);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();

  for (const key of ["{Enter}", " "]) {
    act(() => chip.focus());
    await user.keyboard(key);
    expect(await screen.findByRole("dialog", { name: "review" })).toBeVisible();
    // Outside the popup dismisses it; the editor keeps the draft as it was.
    await user.click(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  expect(f.draft()).toEqual(saved);
  expect(f.input).toHaveValue("Use review ");

  // A stale or missing report leaves the name alone.
  details = undefined;
  await user.click(chip);
  expect(
    await screen.findByRole("dialog", { name: "review" }),
  ).toHaveTextContent(/^review$/);
});

it("returns the caret right after a skill chip when its details close toward it", async () => {
  const skill: ComposerToken = {
    kind: "nexus.skill",
    id: '{"name":"review"}',
    label: "review",
    target: "a".repeat(64),
  };
  const f = mount("Use /rethen", 16000, ({ children }) => (
    <>
      <button type="button">Elsewhere</button>
      {children}
    </>
  ));
  act(() => {
    f.input.insertToken(skill, { start: 4, end: 7 });
  });
  expect(f.input).toHaveValue("Use review then");
  const after = "Use review".length;
  const user = userEvent.setup();
  const chip = screen.getByRole("button", { name: "Skill review" });

  // Base UI moves focus into an opened popup a frame later; close after it.
  const opened = async () => {
    const dialog = await screen.findByRole("dialog", { name: "review" });
    await waitFor(() =>
      expect(dialog).toContainElement(document.activeElement as HTMLElement),
    );
  };

  // Pointer: the caret was elsewhere; Escape puts typing after the chip.
  act(() => f.input.setSelectionRange(0, 0));
  await user.click(chip);
  await opened();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(f.input).toHaveFocus());
  expect(f.input.selectionStart).toBe(after);
  await user.keyboard("!");
  expect(f.input).toHaveValue("Use review! then");

  // Keyboard: Tab reaches the chip, Enter opens it, Escape returns the same.
  act(() => f.input.setSelectionRange(0, 0));
  await user.tab();
  expect(chip).toHaveFocus();
  await user.keyboard("{Enter}");
  await opened();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(f.input).toHaveFocus());
  expect(f.input.selectionStart).toBe(after);

  // Moving focus elsewhere leaves both focus and the caret where they were.
  act(() => f.input.setSelectionRange(0, 0));
  await user.click(chip);
  await opened();
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  await user.click(elsewhere);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(elsewhere).toHaveFocus();
  expect(f.input.selectionStart).toBe(0);
});
