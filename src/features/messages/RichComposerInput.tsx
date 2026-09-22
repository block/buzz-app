import { useLayoutEffect, useRef } from "react";
import styles from "./Messages.module.css";
import "./composer.css";
import type { ConversationExtensions } from "../conversation/contracts";
import type { CustomEmoji } from "../relay/emoji";
import type { RelaySession } from "../relay/session";
import type { MentionDraft } from "./mention-draft";
import type { EditableInputProps } from "./EditableInput";
import type { ComposerInputElement } from "./composer-dom";
import { RichComposerAdapter } from "./rich-composer-adapter";

/** One transaction-driven bridge; Tiptap owns document, selection and Undo. */
export function RichComposerInput({
  draft,
  disabled,
  placeholder,
  "aria-label": accessibleLabel,
  className,
  ref,
  id,
  onInput,
  onFocus,
  onBlur,
  onSelect,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
}: EditableInputProps & {
  draft: MentionDraft;
  session: RelaySession;
  scope: string;
  channelId: string;
  extensions: ConversationExtensions | undefined;
  emoji: readonly CustomEmoji[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const initialDraft = useRef(draft);
  const latest = useRef({
    disabled,
    onInput,
    onFocus,
    onBlur,
    onSelect,
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
  });
  latest.current = {
    disabled,
    onInput,
    onFocus,
    onBlur,
    onSelect,
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
  };

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const owner = new RichComposerAdapter(element, initialDraft.current);
    const input = owner.editor.view.dom as ComposerInputElement;
    input.richComposer = owner;
    input.id = id ?? "";
    input.classList.add(
      "message-composer-editor",
      ...[styles.input, ...(className ?? "").split(" ")].filter(
        (name): name is string => Boolean(name),
      ),
    );

    input.setAttribute("aria-multiline", "true");
    Object.defineProperties(input, {
      value: { configurable: true, get: () => owner.snapshot().editingText },
      selectionStart: {
        configurable: true,
        get: () => owner.snapshot().selectionStart,
      },
      selectionEnd: {
        configurable: true,
        get: () => owner.snapshot().selectionEnd,
      },
      selectionDirection: { configurable: true, get: () => "forward" },
      disabled: { configurable: true, get: () => latest.current.disabled },
      readOnly: { configurable: true, get: () => !owner.snapshot().editable },
      setSelectionRange: {
        configurable: true,
        value: (start: number, end: number) =>
          owner.setEditingSelection(start, end),
      },
    });
    const focus = (event: Event) => latest.current.onFocus?.(event as never);
    const blur = (event: Event) => latest.current.onBlur?.(event as never);
    const composeStart = (event: Event) =>
      latest.current.onCompositionStart?.(event as never);
    const composeEnd = (event: Event) =>
      latest.current.onCompositionEnd?.(event as never);
    const keydown = (event: Event) => {
      const keyboard = event as KeyboardEvent;
      latest.current.onKeyDown?.({
        nativeEvent: keyboard,
        currentTarget: input,
        target: input,
        key: keyboard.key,
        altKey: keyboard.altKey,
        ctrlKey: keyboard.ctrlKey,
        metaKey: keyboard.metaKey,
        shiftKey: keyboard.shiftKey,
        preventDefault: () => keyboard.preventDefault(),
        stopPropagation: () => keyboard.stopPropagation(),
      } as never);
    };
    const selection = () => latest.current.onSelect?.({} as never);
    input.addEventListener("focus", focus);
    input.addEventListener("blur", blur);
    input.addEventListener("compositionstart", composeStart);
    input.addEventListener("compositionend", composeEnd);
    input.addEventListener("keydown", keydown);
    input.ownerDocument.addEventListener("selectionchange", selection);
    ref.current = input;
    const updateEmpty = () => {
      input.dataset.empty = String(owner.editor.isEmpty);
    };
    updateEmpty();
    const stop = owner.subscribe((documentChanged) => {
      updateEmpty();
      if (documentChanged)
        latest.current.onInput?.({
          currentTarget: input,
          target: input,
        } as never);
      else latest.current.onSelect?.({} as never);
    });
    return () => {
      stop();
      input.removeEventListener("focus", focus);
      input.removeEventListener("blur", blur);
      input.removeEventListener("compositionstart", composeStart);
      input.removeEventListener("compositionend", composeEnd);
      input.removeEventListener("keydown", keydown);
      input.ownerDocument.removeEventListener("selectionchange", selection);
      ref.current = null;
      owner.destroy();
    };
  }, [className, id, ref]);

  useLayoutEffect(() => {
    ref.current?.setAttribute("data-placeholder", placeholder);
    ref.current?.setAttribute("aria-label", accessibleLabel ?? placeholder);
  }, [placeholder, accessibleLabel, ref]);

  useLayoutEffect(() => {
    const owner = ref.current?.richComposer;
    owner?.setEditable(!disabled);
    ref.current?.setAttribute("aria-disabled", String(disabled));
  }, [disabled, ref]);

  return <div ref={host} />;
}
