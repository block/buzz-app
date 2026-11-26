import { useEffect, useRef, useState } from "react";
import {
  File,
  getFiletypeFromFileName,
  getHighlighterIfLoaded,
  preloadHighlighter,
} from "@pierre/diffs";
import { theme, useThemeType } from "./DiffViewer";
import { bundledLanguages } from "./grammars";
import styles from "./Diffs.module.css";

export type LineRange = Readonly<{ start: number; end: number }>;

/** The grammar that highlights `name`; "text" for any other language. */
export function codeLanguage(name: string) {
  const language = getFiletypeFromFileName(name);
  return Object.hasOwn(bundledLanguages, language) ? language : "text";
}

/** A highlighted file with its line numbers: all of it, or only `lines`.
 * `selected` lines are marked; with `onSelect`, choosing line numbers
 * selects lines. */
export function CodeFile({
  name,
  contents,
  label,
  lines,
  selected,
  onSelect,
  marked,
  scrollToSelected = false,
}: {
  name: string;
  contents: string;
  label: string;
  lines?: LineRange | undefined;
  selected?: LineRange | null | undefined;
  onSelect?: ((lines: LineRange | null) => void) | undefined;
  /** Lines with a dot in the gutter, such as ones that have comments. */
  marked?: readonly number[] | undefined;
  /** Bring the selection into view when the file first draws. */
  scrollToSelected?: boolean;
}) {
  const language = codeLanguage(name);
  // A final newline ends the last line; it does not start another.
  const text = contents.replace(/\r?\n$/, "");
  const themeType = useThemeType();
  const wrapper = useRef<HTMLElement>(null);
  const instance = useRef<File | undefined>(undefined);
  const select = useRef(onSelect);
  select.current = onSelect;
  const shown = useRef(selected);
  shown.current = selected;
  const [ready, setReady] = useState(
    () => !!getHighlighterIfLoaded({ theme, langs: [language] }),
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void preloadHighlighter({
      themes: [theme.light, theme.dark],
      langs: [language],
      preferredHighlighter: "shiki-js",
    }).then(
      () => active && setReady(true),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [language]);
  const selectable = !!onSelect;
  // The dots draw inside the renderer's shadow root, so they are its CSS.
  const marks = (marked ?? [])
    .filter(Number.isSafeInteger)
    .map((line) => `[data-column-number="${line}"]`)
    .join(",");
  const start = lines?.start;
  const end = lines?.end;
  useEffect(() => {
    const container = wrapper.current;
    if (!ready || failed || !container) return;
    const file = new File({
      theme,
      themeType,
      disableFileHeader: true,
      disableVirtualizationBuffers: true,
      overflow: "scroll",
      tokenizeMaxLineLength: 2_000,
      ...(marks && {
        unsafeCSS: `:is(${marks}){position:relative}:is(${marks})::before{content:"";position:absolute;inset-inline-start:4px;top:50%;translate:0 -50%;width:6px;height:6px;border-radius:50%;background:var(--text-link)}`,
      }),
      enableLineSelection: selectable,
      onLineSelected: (range) =>
        select.current?.(
          range && {
            start: Math.min(range.start, range.end),
            end: Math.max(range.start, range.end),
          },
        ),
      onPostRender: (node) => {
        const root = node.shadowRoot;
        if (root?.querySelector("[data-error-wrapper]")) setFailed(true);
        const code = root?.querySelector("code");
        if (code) {
          // The code scrolls sideways on its own.
          code.tabIndex = 0;
          code.setAttribute("role", "region");
          code.setAttribute("aria-label", label);
        }
      },
    });
    file.render({
      file: { name, contents: text, lang: language },
      containerWrapper: container,
      ...(start !== undefined &&
        end !== undefined && {
          renderRange: {
            startingLine: start - 1,
            totalLines: end - start + 1,
            bufferBefore: 0,
            bufferAfter: 0,
          },
        }),
    });
    const selection = shown.current;
    if (selection) file.setSelectedLines(selection);
    instance.current = file;
    return () => {
      instance.current = undefined;
      file.cleanUp();
    };
  }, [
    ready,
    failed,
    name,
    text,
    language,
    label,
    themeType,
    selectable,
    marks,
    start,
    end,
  ]);
  useEffect(() => {
    instance.current?.setSelectedLines(selected ?? null);
  }, [selected]);
  // Once, when the file first draws: later selections are the person's own.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!scrollToSelected || scrolled.current || !ready || !selected) return;
    scrolled.current = true;
    wrapper.current
      ?.querySelector("diffs-container")
      // The number, not the line: a long line would scroll the code sideways.
      ?.shadowRoot?.querySelector(`[data-column-number="${selected.start}"]`)
      ?.scrollIntoView?.({ block: "center" });
  }, [scrollToSelected, ready, selected]);
  if (failed || !ready)
    return (
      // biome-ignore lint/a11y/useSemanticElements: Keyboard-scrollable plain text while the highlighter loads.
      <pre
        className={styles.raw}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The raw scrollport needs keyboard panning.
        tabIndex={0}
        role="region"
        aria-label={label}
      >
        {start !== undefined && end !== undefined
          ? text
              .split("\n")
              .slice(start - 1, end)
              .join("\n")
          : text}
      </pre>
    );
  return <section ref={wrapper} className={styles.viewer} aria-label={label} />;
}
