import {
  readComposerSnapshot,
  composerMarkdownContext,
} from "../messages/composer-document";
import type { ComposerSnapshot } from "../messages/mention-draft";
import { scanMarkdown } from "../relay/message-content";
import type { ComposerInputElement } from "../messages/composer-dom";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type {
  ComposerCompletion,
  CompletionContext,
  CompletionEdit,
  CompletionQuery,
  ComposerObservation,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { matchCompletion } from "./completion";
import type { CompletionEditor } from "./useCompletionEditor";
import {
  CompletionSession,
  type CompletionGeneration,
} from "./completion-session";
import { CompletionMenu } from "./CompletionMenu";

// Channel links belong in prose, not inside existing links or code.
// Run only after a channel trigger matches; ordinary typing does no extra parsing.
function channelCompletionInProse(
  text: string,
  document: ComposerSnapshot | undefined,
  query: CompletionQuery,
) {
  const doc = readComposerSnapshot(document);
  const context = doc ? composerMarkdownContext(doc) : { text, protected: [] };
  const overlaps = (start: number, end: number) =>
    query.start < end && query.end > start;
  if (context.protected.some(({ start, end }) => overlaps(start, end)))
    return false;
  const { tree, tooDeep } = scanMarkdown(context.text);
  if (tooDeep) return false;
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node) continue;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || !overlaps(start, end))
      continue;
    if (
      [
        "code",
        "inlineCode",
        "link",
        "linkReference",
        "image",
        "imageReference",
        "definition",
        "html",
      ].includes(node.type)
    )
      return false;
    pending.push(...(node.children ?? []));
  }
  return true;
}

type OwnerProps = CompletionContext & {
  registry: ContributionReader<ComposerCompletion>;
  editor: CompletionEditor;
  input: RefObject<ComposerInputElement | null>;
  resolved: Readonly<{
    text: string;
    document?: ComposerSnapshot;
    recipients: readonly Readonly<{ start: number; end: number }>[];
  }>;
  replace(
    edit: CompletionEdit,
    query: CompletionQuery,
    observation: ComposerObservation,
    key?: string,
  ): boolean;
};

export function ComposerCompletions({
  registry,
  editor,
  input,
  replace,
  resolved,
  ...context
}: OwnerProps) {
  const providers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const [session] = useState(() => new CompletionSession());
  const [replay, setReplay] = useState(0);
  const renew = useCallback(() => setReplay((value) => value + 1), []);
  const observation = editor.observation;
  let match =
    observation && resolved.text === observation.text
      ? matchCompletion(providers, observation, context, resolved.recipients)
      : null;
  if (
    observation &&
    match?.provider.pluginId === "buzz.channels" &&
    !channelCompletionInProse(observation.text, resolved.document, match.query)
  )
    match = null;
  const provider = match?.provider;
  const start = match?.query.start;
  const end = match?.query.end;
  const needle = match?.query.query;
  const {
    session: composerSession,
    scope,
    channelId,
    threadRootId,
    inviteAgents,
  } = context;
  const providerContext = useMemo(
    () => ({
      session: composerSession,
      scope,
      channelId,
      threadRootId,
      inviteAgents,
    }),
    [composerSession, scope, channelId, threadRootId, inviteAgents],
  );
  const generation = useMemo(() => {
    // Query visits follow context/input identity even when native text is equal.
    void replay;
    void input;
    return provider &&
      observation &&
      start !== undefined &&
      end !== undefined &&
      needle !== undefined
      ? session.prepare(
          provider,
          registry,
          observation,
          Object.freeze({ start, end, query: needle }),
          providerContext,
        )
      : undefined;
  }, [
    session,
    registry,
    provider,
    observation,
    start,
    end,
    needle,
    providerContext,
    input,
    replay,
  ]);
  return (
    <>
      {generation && (
        <SessionBinding session={session} editor={editor} replace={replace} />
      )}
      {generation && (
        <ContributionBoundary
          key={JSON.stringify([
            contributionKey(generation.provider),
            contributionKey(context.session),
            contributionKey(registry),
            contributionKey(input),
            context.scope,
            context.channelId,
            context.threadRootId,
            context.inviteAgents,
            generation.query.start,
          ])}
          resetIdentity={generation}
          fallback={
            <span role="status">
              {generation.provider.title} suggestions unavailable
            </span>
          }
        >
          <GenerationBinding
            session={session}
            generation={generation}
            renew={renew}
          />
          <ProviderAdapter generation={generation} />
          <CompletionMenu
            key={generation.id}
            session={session}
            generation={generation}
            input={input}
          />
        </ContributionBoundary>
      )}
    </>
  );
}

function SessionBinding({
  session,
  editor,
  replace,
}: {
  session: CompletionSession;
  editor: CompletionEditor;
  replace: OwnerProps["replace"];
}) {
  // This sibling commits before providers, including providers that publish in
  // layout effects. There is no publish-callback state handshake or hook in an
  // imperative adapter. Native observation validity already revokes old queries.
  useLayoutEffect(() => {
    session.configure({ editor, replace });
  });
  useLayoutEffect(() => {
    const keys = editor.keys;
    keys.current = session.handle;
    return () => {
      if (keys.current === session.handle) keys.current = undefined;
      session.configure(undefined);
    };
  }, [session, editor.keys]);
  return null;
}

function GenerationBinding({
  session,
  generation,
  renew,
}: {
  session: CompletionSession;
  generation: CompletionGeneration;
  renew(): void;
}) {
  // A stable logical contribution owner encloses provider AND preview work.
  // Replay retires a capability, not this owner's React identity. Renewal must
  // not key this binding by capability ID and restart an endless mount cycle.
  useLayoutEffect(() => {
    if (!session.activate(generation)) renew();
    return () => session.retire(generation);
  }, [session, generation, renew]);
  return null;
}

function ProviderAdapter({ generation }: { generation: CompletionGeneration }) {
  const Provider = generation.provider.component;
  // Existing contributions may rely on mount-only effects. Stable updates are
  // explicit; every path still receives the immutable query and its own publisher.
  return (
    <Provider
      key={
        generation.provider.queryUpdates === "props" ? "stable" : generation.id
      }
      {...generation.context}
      observation={generation.observation}
      query={generation.query}
      publish={generation.publish}
    />
  );
}
