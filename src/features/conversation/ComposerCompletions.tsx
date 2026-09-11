import { createPortal } from "react-dom";
import { useCompletionPosition } from "./useCompletionPosition";
import {
  useId,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  CompletionContext,
  CompletionEdit,
  CompletionQuery,
  CompletionResult,
  ComposerObservation,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { completionResult, matchCompletion } from "./completion";
import type { CompletionEditor } from "./useCompletionEditor";
import styles from "./Completions.module.css";

const RETRY = Symbol("retry-completion");

export function ComposerCompletions({
  registry,
  editor,
  input,
  replace,
  ...context
}: CompletionContext & {
  registry: ContributionReader<ComposerCompletion>;
  editor: CompletionEditor;
  input: RefObject<HTMLTextAreaElement | null>;
  replace(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
  ): boolean;
}) {
  const providers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const observation = editor.observation;
  const match = observation && matchCompletion(providers, observation, context);
  if (!match || !observation) return null;
  return (
    <ContributionBoundary
      key={JSON.stringify([
        contributionKey(match.provider),
        observation.revision,
        match.query.start,
        match.query.end,
        match.query.query,
      ])}
      fallback={
        <span role="status">
          {match.provider.title} suggestions unavailable
        </span>
      }
    >
      <OwnedCompletion
        {...context}
        registry={registry}
        provider={match.provider}
        query={match.query}
        observation={observation}
        editor={editor}
        input={input}
        replace={replace}
      />
    </ContributionBoundary>
  );
}
function OwnedCompletion({
  provider,
  registry,
  query,
  observation,
  editor,
  input,
  replace,
  ...context
}: CompletionContext & {
  provider: Contribution<ComposerCompletion>;
  registry: ContributionReader<ComposerCompletion>;
  query: CompletionQuery;
  observation: ComposerObservation;
  editor: CompletionEditor;
  input: RefObject<HTMLTextAreaElement | null>;
  replace(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
  ): boolean;
}) {
  const id = useId();
  const popup = useCompletionPosition(input);
  const list = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<CompletionResult>();
  const latest = useRef<CompletionResult | undefined>(undefined);
  const [selected, setSelected] = useState<string | typeof RETRY>();
  const live = useRef(false);
  const current = useRef({ editor, replace });
  useLayoutEffect(() => {
    current.current = { editor, replace };
  });
  const active = useCallback(
    () =>
      live.current &&
      registry.snapshot().includes(provider) &&
      current.current.editor.valid(observation),
    [provider, registry, observation],
  );
  const [publish, setPublish] = useState<ComposerCompletionProps["publish"]>();
  useLayoutEffect(() => {
    live.current = true;
    let owned = true;
    setPublish(() => (incoming: CompletionResult) => {
      if (!owned || !active()) return false;
      const next = completionResult(incoming);
      latest.current = next;
      setResult(next);
      setSelected((previous) =>
        next.items.some((item) => item.id === previous)
          ? previous
          : previous === RETRY && next.retry
            ? RETRY
            : next.items[0]?.id,
      );
      return () => {
        if (latest.current !== next) return;
        latest.current = undefined;
        if (live.current) setResult(undefined);
      };
    });
    return () => {
      owned = false;
      live.current = false;
      latest.current = undefined;
    };
  }, [active]);
  const items = result?.items ?? [];
  const visible = !result || !!(items.length || result.status || result.retry);
  const count = items.length + (result?.retry ? 1 : 0);
  const index =
    selected === RETRY && result?.retry
      ? items.length
      : items.findIndex((item) => item.id === selected);
  const selectedIndex = index < 0 ? 0 : index;
  function accept(index: number) {
    if (!active() || latest.current !== result) return false;
    if (index === items.length && result?.retry) {
      result.retry();
      return true;
    }
    const item = items[index];
    if (!item) return false;
    const accepted = current.current.replace(item.edit, query, observation);
    if (accepted) current.current.editor.invalidate();
    return accepted;
  }
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || !visible) return;
    element.setAttribute("aria-autocomplete", "list");
    element.setAttribute("aria-controls", id);
    if (count)
      element.setAttribute("aria-activedescendant", `${id}-${selectedIndex}`);
    else element.removeAttribute("aria-activedescendant");
    const handle: NonNullable<CompletionEditor["keys"]["current"]> = (
      event,
    ) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        return false;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        current.current.editor.invalidate();
        return true;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return false;
      if (!active()) {
        // A displayed choice owns plain acceptance even when its final evidence
        // was revoked. Never turn a rejected edit into an unintended send.
        if ((event.key === "Enter" || event.key === "Tab") && count) {
          event.preventDefault();
          event.stopPropagation();
          current.current.editor.invalidate();
          return true;
        }
        return false;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
        event.preventDefault();
        event.stopPropagation();
        const next =
          (selectedIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        setSelected(next === items.length ? RETRY : items[next]?.id);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && count) {
        event.preventDefault();
        event.stopPropagation();
        accept(selectedIndex);
        return true;
      }
      return false;
    };
    editor.keys.current = handle;
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
    return () => {
      if (editor.keys.current === handle) editor.keys.current = undefined;
      element.removeAttribute("aria-autocomplete");
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-activedescendant");
    };
  });
  const Provider = provider.component;
  return (
    <>
      {publish && (
        <Provider
          {...context}
          observation={observation}
          query={query}
          publish={publish}
        />
      )}
      {visible &&
        input.current &&
        createPortal(
          <section
            ref={popup}
            className={styles.popup}
            aria-label={`${provider.title} suggestions`}
          >
            <div
              id={id}
              role="listbox"
              aria-label={`${provider.title} suggestions`}
              ref={list}
              className={styles.list}
            >
              {items.map((item, i) => (
                // The textarea owns keyboard focus/selection via aria-activedescendant.
                // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
                <div
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === selectedIndex}
                  id={`${id}-${i}`}
                  key={item.id}
                  onPointerDown={(event) => {
                    if (event.button === 0) event.preventDefault();
                  }}
                  onClick={() => accept(i)}
                  className={styles.option}
                >
                  {item.preview && (
                    <span aria-hidden="true" className={styles.preview}>
                      {item.preview}
                    </span>
                  )}
                  <span className={styles.label}>
                    {item.label}
                    {item.detail && <small>{item.detail}</small>}
                  </span>
                </div>
              ))}
              {result?.retry && (
                // biome-ignore lint/a11y/useKeyWithClickEvents: Keyboard acceptance belongs to the focused textarea.
                <div
                  role="option"
                  tabIndex={-1}
                  id={`${id}-${items.length}`}
                  aria-selected={selectedIndex === items.length}
                  className={styles.option}
                  onPointerDown={(event) => {
                    if (event.button === 0) event.preventDefault();
                  }}
                  onClick={() => accept(items.length)}
                >
                  Retry suggestions
                </div>
              )}
            </div>
            <p role="status">
              {result?.status ??
                (!result
                  ? "Loading suggestions…"
                  : !items.length && !result.retry
                    ? "No matches"
                    : "")}
              {count > 0 &&
                " ↑ ↓ to navigate · Enter or Tab to select · Esc to dismiss"}
            </p>
          </section>,
          input.current.ownerDocument.body,
        )}
    </>
  );
}
