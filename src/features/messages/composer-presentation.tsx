import {
  memo,
  useLayoutEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { Node as EditorNode } from "prosemirror-model";
import {
  authoredComposerDocument,
  composerMarkdownContext,
  projectComposerDocument,
  type SourceRange,
} from "./composer-document";
import { mentionDraft, type MentionDraft } from "./mention-draft";
import { scanMarkdown } from "../relay/message-content";
import { profileKey } from "../profiles/target";
import { messageLinkParts } from "./message-link-parts";
import type { ComposerResource } from "../conversation/contracts";
import styles from "./EditableInput.module.css";

export type EditorDecoration = SourceRange & {
  content: ReactNode;
  editAsText?: boolean;
  /** Facts which affect this entry's artwork, independent of its position. */
  facts?: readonly unknown[];
};

/** Authored analysis has no media, directory, renderer or React lifetime. */
export type ComposerAnalysis = MentionDraft & {
  context: string;
  literals: readonly SourceRange[];
  protected: readonly SourceRange[];
  tooDeep: boolean;
  links: readonly SourceRange[];
  profiles: ReadonlyMap<number, { end: number; pubkey: string; label: string }>;
  images: readonly (SourceRange & {
    url?: string | undefined;
    alt?: string | null | undefined;
  })[];
};

type Projection = ReturnType<typeof projectComposerDocument>;
type Presenter = (analysis: ComposerAnalysis) => readonly EditorDecoration[];
type HostContent = { content: ReactNode; facts: readonly unknown[] };
export type ComposerTokenHost = {
  id: number;
  element: HTMLElement;
  source: string;
  resource: ComposerResource | null;
  position(): number | undefined;
  snapshot: HostContent;
  listeners: Set<() => void>;
};

const sameFacts = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length &&
  a.every((value, index) => Object.is(value, b[index]));

function analyze(doc: EditorNode, source: Projection): ComposerAnalysis {
  const safe = mentionDraft({
    text: source.draft.text,
    recipients: source.draft.recipients,
  });
  const context = composerMarkdownContext(doc, source);
  const { tree, links, tooDeep } = scanMarkdown(context.text);
  const literals: SourceRange[] = [...context.protected];
  const images: ComposerAnalysis["images"][number][] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "image" && start !== undefined && end !== undefined)
      images.push({ start, end, url: node.url, alt: node.alt });
    if (
      [
        "code",
        "inlineCode",
        "image",
        "imageReference",
        "definition",
        "html",
      ].includes(node.type)
    ) {
      if (start !== undefined && end !== undefined)
        literals.push({ start, end });
    } else pending.push(...(node.children ?? []));
  }
  const profiles = new Map<
    number,
    { end: number; pubkey: string; label: string }
  >();
  for (const link of links) {
    const pubkey = link.url && profileKey(link.url);
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    if (!pubkey || start === undefined || end === undefined) continue;
    let label = "";
    const pending = [...(link.children ?? [])].reverse();
    while (pending.length) {
      const node = pending.pop();
      if (node?.value) label += node.value;
      else pending.push(...(node?.children ?? []).slice().reverse());
    }
    profiles.set(start, { end, pubkey, label: label.replace(/^@/, "") });
  }
  const plainLinks: SourceRange[] = [];
  messageLinkParts(context.text, undefined, (start, end) =>
    plainLinks.push({ start, end }),
  );
  return {
    ...safe,
    document: { version: 1, content: doc.toJSON() },
    context: context.text,
    literals,
    protected: context.protected,
    tooDeep,
    links: plainLinks,
    profiles,
    images,
  };
}

/** One editor owns one authored graph and its derived native-view hosts.
 * A resource update resolves existing semantic candidates; it never reparses a
 * stored snapshot or uses a toolbar render to discover a new node view. */
export class ComposerPresentationGraph {
  private authored: EditorNode | undefined;
  private viewDocument: EditorNode | undefined;
  private analysis: ComposerAnalysis | undefined;
  private source: Projection | undefined;
  private presenter: Presenter;
  private reconcile: (() => void) | undefined;
  private hosts: readonly ComposerTokenHost[] = [];
  private publishedHosts: readonly ComposerTokenHost[] = this.hosts;
  private changedHosts = new Set<ComposerTokenHost>();
  private hostListeners = new Set<() => void>();
  private nextHost = 0;
  ranges: readonly EditorDecoration[] = [];

  constructor(presenter: Presenter) {
    this.presenter = presenter;
  }

  get draft(): MentionDraft {
    const value = this.analysis;
    if (!value) throw new Error("Composer authored document is not installed");
    return {
      text: value.text,
      recipients: value.recipients,
      ...(value.document ? { document: value.document } : {}),
    };
  }

  read(doc: EditorNode, source: Projection) {
    this.source = source;
    if (this.viewDocument === doc) return;
    this.viewDocument = doc;
    const authored = authoredComposerDocument(doc);
    if (!this.authored?.eq(authored)) {
      this.authored = authored;
      this.analysis = analyze(authored, projectComposerDocument(authored));
      this.ranges = this.presenter(this.analysis);
    }
  }

  connect(reconcile: () => void) {
    this.reconcile = reconcile;
    return () => {
      this.reconcile = undefined;
    };
  }

  /** Publish only committed React resource/name/renderer inputs. */
  present(presenter: Presenter) {
    this.presenter = presenter;
    if (!this.analysis) return;
    const before = this.ranges;
    this.ranges = presenter(this.analysis);
    if (
      before.length !== this.ranges.length ||
      before.some((item, index) => {
        const next = this.ranges[index];
        return (
          !next ||
          item.start !== next.start ||
          item.end !== next.end ||
          !!item.editAsText !== !!next.editAsText
        );
      })
    )
      this.reconcile?.();
    this.refreshHosts();
  }

  readonly subscribeHosts = (listener: () => void) => {
    this.hostListeners.add(listener);
    return () => this.hostListeners.delete(listener);
  };
  readonly hostSnapshot = () => this.publishedHosts;

  hasNativeHosts() {
    return this.hosts.length > 0;
  }

  attach(
    element: HTMLElement,
    node: EditorNode,
    position: () => number | undefined,
  ) {
    const host: ComposerTokenHost = {
      id: ++this.nextHost,
      element,
      source: node.attrs.source,
      resource: node.attrs.resource,
      position,
      snapshot: { content: node.attrs.source, facts: [node.attrs.source] },
      listeners: new Set(),
    };
    this.hosts = [...this.hosts, host];
    this.refresh(host);
    return {
      host,
      update: (next: EditorNode) => {
        host.source = next.attrs.source;
        host.resource = next.attrs.resource;
        this.refresh(host);
      },
      destroy: () => {
        this.hosts = this.hosts.filter((item) => item !== host);
        host.listeners.clear();
      },
    };
  }

  /** Native updateState finishes before any React observer sees new hosts. */
  refreshHosts() {
    for (const host of this.hosts) this.refresh(host);
    if (this.publishedHosts !== this.hosts) {
      this.publishedHosts = this.hosts;
      for (const listener of this.hostListeners) listener();
    }
    for (const host of this.changedHosts)
      for (const listener of host.listeners) listener();
    this.changedHosts.clear();
  }

  releaseHosts() {
    this.hosts = [];
    this.viewDocument = undefined;
    this.refreshHosts();
  }

  private refresh(host: ComposerTokenHost) {
    const position = host.position();
    const start =
      position === undefined ? undefined : this.source?.source(position);
    const range = this.ranges.find(
      (item) =>
        item.start === start && item.end === (start ?? 0) + host.source.length,
    );
    const facts = host.resource
      ? ["resource", host.resource.uri, host.resource.label]
      : (range?.facts ?? [range?.content ?? host.source]);
    if (sameFacts(host.snapshot.facts, facts)) return;
    host.snapshot = {
      facts,
      content: host.resource ? (
        <>
          <span className="sr-only">Resource: </span>
          <span className={styles.resource}>{host.resource.label}</span>
        </>
      ) : (
        (range?.content ?? host.source)
      ),
    };
    this.changedHosts.add(host);
  }
}

const ComposerTokenPortal = memo(function ComposerTokenPortal({
  host,
  committed,
}: {
  host: ComposerTokenHost;
  committed(): void;
}) {
  const snapshot = useSyncExternalStore(
    (listener) => {
      host.listeners.add(listener);
      return () => host.listeners.delete(listener);
    },
    () => host.snapshot,
  );
  useLayoutEffect(committed);
  return createPortal(snapshot.content, host.element);
});

export const ComposerTokenPortals = memo(function ComposerTokenPortals({
  graph,
  committed,
}: {
  graph: ComposerPresentationGraph;
  committed(): void;
}) {
  const hosts = useSyncExternalStore(graph.subscribeHosts, graph.hostSnapshot);
  return hosts.map((host) => (
    <ComposerTokenPortal key={host.id} host={host} committed={committed} />
  ));
});
