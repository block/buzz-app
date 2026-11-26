import { useEffect, useMemo, useRef, useState } from "react";
import {
  File,
  type FileOptions,
  VirtualizedFile,
  Virtualizer,
  getFiletypeFromFileName,
  getHighlighterIfLoaded,
  preloadHighlighter,
} from "@pierre/diffs";
import {
  getOrCreateWorkerPoolSingleton,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";
// The URL only: the worker's code must not run where it is imported.
import highlightWorker from "@pierre/diffs/worker/worker.js?worker&url";
import { theme, useThemeType } from "./DiffViewer";
import { bundledLanguages } from "./grammars";
import styles from "./Diffs.module.css";

export type LineRange = Readonly<{ start: number; end: number }>;

/** The grammar that highlights `name`; "text" for any other language. */
export function codeLanguage(name: string) {
  const language = getFiletypeFromFileName(name);
  return Object.hasOwn(bundledLanguages, language) ? language : "text";
}

const tokenizeMaxLineLength = 2_000;

/** The workers that highlight code off the main thread, shared by every
 * file; undefined where there are no workers, which highlight in place. */
function highlightPool(): WorkerPoolManager | undefined {
  if (typeof Worker === "undefined") return undefined;
  return getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: () => new Worker(highlightWorker, { type: "module" }),
      poolSize: 2,
    },
    highlighterOptions: {
      theme,
      preferredHighlighter: "shiki-js",
      tokenizeMaxLineLength,
    },
  });
}

/** A short fingerprint of `text`, so files with the same contents share one
 * highlight. */
function fingerprint(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** The element `node` scrolls inside, if any. */
function scrollParent(node: Element) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return undefined;
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
  windowed = false,
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
  /** Draw only the lines near the screen of the element it scrolls in. */
  windowed?: boolean;
}) {
  const language = codeLanguage(name);
  // A final newline ends the last line; it does not start another.
  const text = contents.replace(/\r?\n$/, "");
  const themeType = useThemeType();
  const wrapper = useRef<HTMLElement>(null);
  const instance = useRef<File | undefined>(undefined);
  const scroller = useRef<Virtualizer | undefined>(undefined);
  const select = useRef(onSelect);
  select.current = onSelect;
  const shown = useRef(selected);
  shown.current = selected;
  const cacheKey = useMemo(() => `${name}:${fingerprint(text)}`, [name, text]);
  // With workers, the file draws as plain text once they start, and its
  // colors arrive from a worker.
  const [pool] = useState(highlightPool);
  const [ready, setReady] = useState(() =>
    pool?.isInitialized()
      ? true
      : !!getHighlighterIfLoaded({ theme, langs: [language] }),
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const preload = () =>
      preloadHighlighter({
        themes: [theme.light, theme.dark],
        langs: [language],
        preferredHighlighter: "shiki-js",
      });
    // Workers that fail to start leave the highlighting to this thread.
    void (pool ? pool.initialize().catch(preload) : preload()).then(
      () => active && setReady(true),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [pool, language]);
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
    const root = windowed ? scrollParent(container) : undefined;
    const virtualizer = root ? new Virtualizer() : undefined;
    if (root) virtualizer?.setup(root);
    const options: FileOptions<undefined, undefined> = {
      theme,
      themeType,
      disableFileHeader: true,
      // The lines not drawn keep their height.
      disableVirtualizationBuffers: !virtualizer,
      overflow: "scroll",
      tokenizeMaxLineLength,
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
    };
    const file = virtualizer
      ? new VirtualizedFile(options, virtualizer, undefined, pool)
      : new File(options, pool);
    file.render({
      file: { name, contents: text, lang: language, cacheKey },
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
    scroller.current = virtualizer;
    return () => {
      instance.current = undefined;
      scroller.current = undefined;
      file.cleanUp();
      virtualizer?.cleanUp();
    };
  }, [
    ready,
    failed,
    name,
    text,
    language,
    cacheKey,
    pool,
    label,
    themeType,
    selectable,
    marks,
    start,
    end,
    windowed,
  ]);
  useEffect(() => {
    instance.current?.setSelectedLines(selected ?? null);
  }, [selected]);
  // Once, when the file first draws: later selections are the person's own.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!scrollToSelected || scrolled.current || !ready || !selected) return;
    scrolled.current = true;
    // A windowed file may not have drawn the line yet, so it goes by position.
    const file = instance.current;
    const root = scroller.current?.getRoot();
    if (file instanceof VirtualizedFile && root instanceof HTMLElement) {
      const line = file.getLinePosition(selected.start);
      if (line)
        root.scrollTop =
          (file.top ?? 0) + line.top - (root.clientHeight - line.height) / 2;
      return;
    }
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
