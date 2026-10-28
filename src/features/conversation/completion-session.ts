import type { KeyboardEvent } from "react";
import type { Contribution } from "../../plugins/contributions";
import type { ComposerInputElement } from "../messages/composer-dom";
import type {
  ComposerCompletion,
  ComposerCompletionProps,
  ComposerObservation,
  CompletionContext,
  CompletionEdit,
  CompletionQuery,
  CompletionResult,
  ContributionReader,
} from "./contracts";
import { completionResult } from "./completion";
import type { CompletionEditor } from "./useCompletionEditor";

export const COMPLETION_RETRY = Symbol("retry-completion");
type Choice = string | typeof COMPLETION_RETRY | undefined;
type Owner = {
  editor: CompletionEditor;
  replace(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ): boolean;
};

/** One immutable query visit. Its publisher can never be rebound to another visit. */
export type CompletionGeneration = Readonly<{
  id: number;
  provider: Contribution<ComposerCompletion>;
  registry: ContributionReader<ComposerCompletion>;
  observation: ComposerObservation;
  query: CompletionQuery;
  context: CompletionContext;
  publish: ComposerCompletionProps["publish"];
}>;
type Publication = Readonly<{ result: CompletionResult }>;
export type CompletionPresentation = Readonly<{
  generation: CompletionGeneration;
  publication: Publication | undefined;
  selected: Choice;
  commandRevision: number;
  revision: number;
  reveal: boolean;
}>;

/**
 * An editor owns one command authority. Providers produce generation-bound
 * evidence; React acknowledges what it actually committed, independently of
 * the newest publication and commands that have not reached the view yet.
 */
export class CompletionSession {
  private nextGeneration = 0;
  private nextPresentation = 0;
  private owner: Owner | undefined;
  private generation: CompletionGeneration | undefined;
  private retired = new WeakSet<CompletionGeneration>();
  private latest: Publication | undefined;
  private displayed: CompletionPresentation | undefined;
  private selected: Choice;
  private command: Choice;
  private commandRevision = 0;
  private revealed = 0;
  private presentation: CompletionPresentation | undefined;
  private listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.presentation;

  /** Pure allocation: authority starts only when the host commits this visit. */
  prepare(
    provider: Contribution<ComposerCompletion>,
    registry: ContributionReader<ComposerCompletion>,
    observation: ComposerObservation,
    query: CompletionQuery,
    context: CompletionContext,
  ): CompletionGeneration {
    const generation: CompletionGeneration = {
      id: ++this.nextGeneration,
      provider,
      registry,
      observation,
      query,
      context,
      publish: (incoming) => this.publish(generation, incoming),
    };
    return Object.freeze(generation);
  }

  configure(owner: Owner) {
    this.owner = owner;
  }

  activate(generation: CompletionGeneration | undefined) {
    if (generation && this.retired.has(generation)) return false;
    if (this.generation === generation) return true;
    if (this.generation) this.retired.add(this.generation);
    this.generation = generation;
    this.latest = undefined;
    this.displayed = undefined;
    this.selected = undefined;
    this.command = undefined;
    this.commandRevision = 0;
    this.update(false);
    return true;
  }

  retire(generation: CompletionGeneration | undefined) {
    if (!generation) return;
    this.retired.add(generation);
    if (this.generation === generation) this.activate(undefined);
  }

  private active(generation: CompletionGeneration) {
    return (
      this.generation === generation &&
      !this.retired.has(generation) &&
      generation.registry.snapshot().includes(generation.provider) &&
      !!this.owner?.editor.valid(generation.observation)
    );
  }

  private update(reveal: boolean) {
    this.presentation = this.generation
      ? Object.freeze({
          generation: this.generation,
          publication: this.latest,
          selected: this.selected,
          commandRevision: this.commandRevision,
          revision: ++this.nextPresentation,
          reveal,
        })
      : undefined;
    for (const listener of this.listeners) listener();
  }

  private publish(
    generation: CompletionGeneration,
    incoming: CompletionResult,
  ) {
    if (!this.active(generation)) return false;
    const publication = { result: completionResult(incoming) };
    this.latest = publication;
    const result = publication.result;
    if (
      !result.items.some((item) => item.id === this.selected) &&
      !(this.selected === COMPLETION_RETRY && result.retry)
    )
      this.selected = undefined;
    this.update(true);
    return () => {
      // A disposer withdraws precisely its publication, never a later answer.
      if (this.generation !== generation || this.latest !== publication) return;
      this.latest = undefined;
      this.update(false);
    };
  }

  /** A render or an abandoned tree is not displayed evidence. */
  committed(
    generation: CompletionGeneration,
    presentation: CompletionPresentation | undefined,
  ) {
    if (this.generation !== generation) return false;
    this.displayed = presentation;
    if (
      presentation?.publication === this.latest &&
      (presentation?.commandRevision ?? 0) === this.commandRevision
    ) {
      const result = presentation?.publication?.result;
      this.command =
        presentation?.selected === COMPLETION_RETRY && result?.retry
          ? COMPLETION_RETRY
          : (result?.items.find((item) => item.id === presentation?.selected)
              ?.id ??
            result?.items[0]?.id ??
            (result?.retry ? COMPLETION_RETRY : undefined));
    }
    if (!presentation?.reveal || this.revealed === presentation.revision)
      return false;
    this.revealed = presentation.revision;
    return true;
  }

  select(generation: CompletionGeneration, choice: Choice, reveal = false) {
    if (this.generation !== generation) return;
    this.command = choice;
    ++this.commandRevision;
    this.selected = choice;
    this.update(reveal);
  }

  accept(generation: CompletionGeneration, choice: Choice, key = "click") {
    const published = this.latest?.result;
    if (!this.active(generation) || !published) return false;
    if (choice === COMPLETION_RETRY) {
      if (!published.retry) return false;
      published.retry();
      return true;
    }
    const item = published.items.find((item) => item.id === choice);
    const terminator =
      generation.provider.pluginId === "buzz.emoji" ? ":" : " ";
    if (key === terminator && item?.id !== published.spaceId) return false;
    if (!item || item.disabled || item.canSelect?.(key) === false) return false;
    const accepted = this.owner?.replace(
      item.edit,
      generation.query,
      generation.observation,
      key,
    );
    if (accepted) this.owner?.editor.invalidate();
    return !!accepted;
  }

  readonly handle = (event: KeyboardEvent<ComposerInputElement>) => {
    const generation = this.generation;
    if (!generation || !this.owner) return false;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return false;
    const displayed = this.displayed;
    const view = displayed?.publication?.result;
    const count = (view?.items.length ?? 0) + (view?.retry ? 1 : 0);
    const visible = !!(count || view?.status);
    // Only the same current committed empty answer releases ordinary keys.
    if (view && !visible && displayed?.publication === this.latest)
      return false;
    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    if (event.key === "Escape") {
      this.owner.editor.invalidate();
      return consume();
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.shiftKey && event.key !== ":") return false;
    const published = this.latest?.result;
    const choices = published?.items ?? [];
    const commandCount = choices.length + (published?.retry ? 1 : 0);
    const ownsAcceptance = !!(
      count ||
      commandCount ||
      this.command !== undefined
    );
    if (!this.active(generation)) {
      if ((event.key === "Enter" || event.key === "Tab") && ownsAcceptance) {
        this.owner.editor.invalidate();
        return consume();
      }
      return false;
    }
    const terminator =
      generation.provider.pluginId === "buzz.emoji" ? ":" : " ";
    if (event.key === terminator && view?.spaceId) {
      const shown = view.items.find((item) => item.id === view.spaceId);
      return this.accept(generation, shown?.id, terminator) ? consume() : false;
    }
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      commandCount
    ) {
      const index =
        this.command === COMPLETION_RETRY && published?.retry
          ? choices.length
          : choices.findIndex((item) => item.id === this.command);
      const next =
        (Math.max(0, index) +
          (event.key === "ArrowDown" ? 1 : commandCount - 1)) %
        commandCount;
      this.select(
        generation,
        next === choices.length ? COMPLETION_RETRY : choices[next]?.id,
        true,
      );
      return consume();
    }
    if ((event.key === "Enter" || event.key === "Tab") && ownsAcceptance) {
      this.accept(
        generation,
        this.command ??
          choices[0]?.id ??
          (published?.retry ? COMPLETION_RETRY : undefined),
        event.key,
      );
      return consume();
    }
    return false;
  };
}
