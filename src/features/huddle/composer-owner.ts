import { communityFromScope, relayGifRequests } from "../relay/gifs";
import { MAX_VOICE_SECONDS } from "../relay/voice-media";
import { mentionDraft } from "../messages/mention-draft";
import { readView, writeView } from "../../shared/view-state";
import { lastEditableMessage } from "../messages/useMessageEdit";
import type { RelaySession } from "../relay/session";
import { canAddMembers } from "../channel-members/members";
import { prepareAttachment } from "../messages/prepare-attachment";
import {
  UPLOAD_MAX_BYTES,
  type UploadedAttachment,
} from "../relay/attachments";
import type {
  ComposerCommand,
  ComposerReader,
  ComposerRequest,
  ComposerResponse,
  ComposerSnapshot,
} from "./composer-contract";

/** One unpredictable, native-delivered capability for one room in one main session.
 * File bytes use structured cloning; all preparation, signing and delivery stay here. */
export function createHuddleComposerOwner(
  session: RelaySession,
  room: string,
  parent: string,
  extensions: ComposerReader | undefined,
  current: () => boolean,
  verified?: () => boolean,
  agents?: import("../agents/service").Agents,
  /** Reply into this thread of `room` instead of posting to the room. */
  thread?: string,
  /** The messages this window currently shows: reactions are admitted only
   * against them, from main's own view of their reaction events, and never
   * while main still has a reaction operation in flight for the message. */
  shown?: {
    message(
      id: string,
    ): import("../relay/contracts").ChannelMessage | undefined;
    reactionBusy(messageId: string): boolean;
    retryOperation(id: string): boolean;
    /** The projection version now, answered with each admission. */
    version(): number;
    root(): import("../relay/contracts").ChannelMessage | undefined;
    /** Record an operation main admitted for this window. */
    admit(
      id: string,
      messageId: string | undefined,
      kind: 7 | 5 | 40003 | 9,
    ): void;
    /** The companion reconciled these terminal reports. */
    acknowledge(ids: readonly string[]): void;
    /** Verified agent-owner authority for a shown message, or none. */
    authorization(
      id: string,
    ): import("../relay/messages").AgentOwnerAuthorization | undefined;
  },
) {
  const draftKey = thread ? `draft:${room}:thread:${thread}` : `draft:${room}`;
  async function modelChoices(pubkeys: readonly string[]) {
    const revision = modelRevision;
    if (
      !Array.isArray(pubkeys) ||
      pubkeys.length > 128 ||
      pubkeys.some(
        (key) => typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key),
      )
    )
      throw new Error("Invalid agent selection.");
    const choices = await Promise.all(
      [...new Set(pubkeys)].map(async (pubkey) => {
        const agent = agents
          ?.snapshot()
          .agents.find((item) => item.pubkey === pubkey);
        const type =
          agent && agents?.types().find((item) => item.key === agent.type);
        if (!agent || !type?.models) return [];
        const models = await type.models(agent);
        if (
          agents?.snapshot().agents.find((item) => item.pubkey === pubkey) !==
          agent
        )
          throw new Error("Agent settings changed. Choose again.");
        return [{ ...models, pubkey, name: agent.name }];
      }),
    );
    check();
    if (revision !== modelRevision)
      throw new Error("Agent settings changed. Choose again.");
    return choices.flat();
  }
  const token = crypto.randomUUID();
  const channel = new BroadcastChannel(`buzz.huddle.composer.${token}`);
  let closed = false;
  let modelRevision = 0;
  let client = "";
  let highest = 0;
  let uploadBytes = 0;
  const gifUrls = new Set<string>();
  const active = new Map<number, AbortController>();
  const results = new Map<number, ComposerResponse>();
  const uploaded = new Map<
    string,
    { file: UploadedAttachment; uses: number }
  >();
  const release = (file: UploadedAttachment) => {
    const key = JSON.stringify([file.url, file.sha256]);
    const entry = uploaded.get(key);
    if (!entry) return;
    if (--entry.uses === 0) uploaded.delete(key);
  };
  const metadata = () =>
    session.channels.get?.(room) ??
    session.channels.list().channels.find((c) => c.id === room);
  function check(write = false) {
    const c = metadata();
    if (
      closed ||
      !current() ||
      !c ||
      !(verified ? verified() : c.huddle && c.parentChannelId === parent)
    )
      throw new Error("This Huddle conversation is no longer available.");
    // A Huddle room's roster is always in its summary; a channel thread
    // follows the main composer and trusts the relay's readOnly flag instead.
    if (
      write &&
      (c.archived ||
        c.readOnly ||
        c.cached ||
        !session.viewer ||
        (!thread && !c.members?.includes(session.viewer)))
    )
      throw new Error(
        thread
          ? "This thread is read-only."
          : "This Huddle conversation is read-only.",
      );
  }
  const send = (response: ComposerResponse) => {
    if (!closed) channel.postMessage(response);
  };
  function snapshot(): ComposerSnapshot {
    const media = new Map<string, string | undefined>();
    const remember = (url: string | undefined) => {
      if (url) {
        media.set(url, session.media(url));
        media.set(`${url}:small`, session.media(url, "small"));
      }
    };
    const profiles = session.profiles.snapshot();
    for (const profile of profiles.values()) remember(profile.picture);
    for (const emoji of session.emoji.snapshot().entries) remember(emoji.url);
    for (const { file } of uploaded.values()) remember(file.url);
    for (const url of gifUrls) remember(url);
    let writable = true;
    try {
      check(true);
    } catch {
      writable = false;
    }
    const roomMetadata = metadata();
    return {
      room,
      thread,
      modelRevision,
      viewer: session.viewer,
      scope: session.scope,
      writable,
      uploads: !!session.attachments,
      canAdd: canAddMembers(session, metadata()),
      channels: {
        ...session.channels.list(),
        channels: [
          ...session.channels.list().channels.filter((c) => c.id !== room),
          ...(roomMetadata ? [roomMetadata] : []),
        ],
      },
      profiles,
      profileGeneration: session.profiles.generation?.() ?? 0,
      emoji: session.emoji.snapshot(),
      agents: session.agentChoices.snapshot(),
      library: session.agentLibrary.snapshot(),
      archives: session.archives.snapshot(),
      typing: session.typing.snapshot().filter((t) => t.channelId === room),
      media,
      tools: extensions?.tools.snapshot().map((t) => t.key) ?? [],
      completions: extensions?.completions?.snapshot().map((t) => t.key) ?? [],
    };
  }
  function publish() {
    if (!closed && client)
      send({ kind: "snapshot", client, value: snapshot() });
  }
  async function execute(
    request: ComposerRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    check();
    signal.throwIfAborted();
    switch (request.op) {
      case "gifSupport":
      case "gifSearch": {
        const community = communityFromScope(session.scope);
        if (
          !community ||
          !extensions?.tools
            .snapshot()
            .some((tool) => tool.key === "buzz.emoji/picker")
        )
          throw new Error("GIF search is unavailable.");
        if (request.op === "gifSupport")
          return relayGifRequests.supports(community, signal);
        if (typeof request.args !== "string" || request.args.length > 256)
          throw new Error("Invalid GIF search.");
        const gifs = await relayGifRequests.search(
          community,
          request.args,
          signal,
        );
        signal.throwIfAborted();
        check();
        for (const gif of gifs) {
          // Match the URL escaping used by gifMarkdown when the picker inserts it.
          gifUrls.add(
            gif.original.url.replace(/\(/g, "%28").replace(/\)/g, "%29"),
          );
        }
        publish();
        return gifs;
      }
      case "models":
        return modelChoices(request.args);
      case "send":
      case "reply": {
        check(true);
        if ((request.op === "reply") !== !!thread)
          throw new Error("This composer targets a different conversation.");
        const { text, draft, mentions, references, attachments } = request.args;
        if (
          typeof draft !== "string" ||
          draft.length > 262144 ||
          typeof text !== "string" ||
          text.length > 16000 ||
          !Array.isArray(mentions) ||
          !Array.isArray(references) ||
          [...mentions, ...references].some((k) => !/^[0-9a-f]{64}$/.test(k)) ||
          mentions.length + references.length > 128 ||
          !Array.isArray(attachments) ||
          attachments.length > 10 ||
          (!text.trim() && !attachments.length)
        )
          throw new Error("Invalid Huddle message.");
        const files = attachments.map((file) => {
          const known = uploaded.get(JSON.stringify([file.url, file.sha256]));
          if (!known) throw new Error("Reattach this file before sending.");
          const voice = file.voice;
          if (
            voice &&
            (known.file.type !== "audio/wav" ||
              !Number.isFinite(voice.duration) ||
              voice.duration <= 0 ||
              voice.duration > MAX_VOICE_SECONDS + 0.1 ||
              !Array.isArray(voice.waveform) ||
              !voice.waveform.length ||
              voice.waveform.length > 100 ||
              voice.waveform.some(
                (value: number) =>
                  !Number.isInteger(value) || value < 0 || value > 100,
              ))
          )
            throw new Error("Invalid voice note metadata.");
          return voice
            ? {
                ...known.file,
                voice: {
                  duration: voice.duration,
                  waveform: [...voice.waveform],
                },
              }
            : known.file;
        });
        const picks = request.args.picks ?? {};
        if (
          typeof picks !== "object" ||
          Array.isArray(picks) ||
          Object.keys(picks).length > 128
        )
          throw new Error("Invalid agent model choices.");
        const choices = await modelChoices(Object.keys(picks));
        for (const [pubkey, pick] of Object.entries(picks)) {
          const choice = choices.find((item) => item.pubkey === pubkey);
          const model = choice?.models.find(
            (item) => item.id === (pick?.model ?? choice.current),
          );
          if (
            !mentions.includes(pubkey) ||
            !model ||
            !pick ||
            Object.keys(pick).some(
              (key) => key !== "model" && key !== "effort",
            ) ||
            (pick.effort !== undefined &&
              !model.efforts.some((item) => item.id === pick.effort))
          )
            throw new Error("Agent model choices changed. Choose again.");
        }
        const parent = request.op === "reply" ? request.args.parent : undefined;
        if (parent !== undefined && !/^[0-9a-f]{64}$/.test(parent))
          throw new Error("Invalid reply target.");
        check(true);
        signal.throwIfAborted();
        const id =
          request.op === "reply" && thread
            ? session.messages.reply(
                room,
                thread,
                text,
                mentions,
                files,
                parent ?? thread,
                references,
                picks,
              )
            : session.messages.send(
                room,
                text,
                mentions,
                files,
                undefined,
                references,
                picks,
              );
        // Admission owns the persisted draft too: closing the child before its
        // acknowledgement must not restore a message already in the main
        // outbox. The stub is what the composer saves for every send; it
        // keeps the remembered agents in memory (see seedMentions).
        const scope = session.scope;
        if (JSON.stringify(readView(scope, draftKey, null)) === draft)
          writeView(scope, draftKey, mentionDraft(""));
        for (const file of files) release(file);
        return id;
      }
      case "react":
      case "removeReactions":
      case "deleteMessage":
      case "edit":
      case "sendToChannel":
      case "markRead":
      case "report": {
        check(request.op !== "markRead" && request.op !== "report");
        if (!thread || !shown)
          throw new Error("This action is not available in a Huddle composer.");
        const { messageId } = request.args;
        const target =
          typeof messageId === "string" && /^[0-9a-f]{64}$/.test(messageId)
            ? shown.message(messageId)
            : undefined;
        if (!target || target.channelId !== room)
          throw new Error("This message is not shown in this window.");
        const admitted = (id: string, kind: 7 | 5 | 40003 | 9) => {
          shown.admit(id, messageId, kind);
          return { id, version: shown.version() };
        };
        const delivered =
          !target.delivery || ["accepted", "seen"].includes(target.delivery);
        const own = target.authorId === session.viewer;
        switch (request.op) {
          case "react": {
            if (shown.reactionBusy(messageId))
              throw new Error(
                "A reaction on this message is still being sent.",
              );
            const { content, emoji } = request.args;
            if (typeof content !== "string" || content.length > 512)
              throw new Error("Invalid reaction.");
            if (
              emoji !== undefined &&
              (typeof emoji !== "object" ||
                !emoji ||
                typeof emoji.shortcode !== "string" ||
                typeof emoji.url !== "string" ||
                emoji.shortcode.length > 64 ||
                emoji.url.length > 8192)
            )
              throw new Error("Invalid custom emoji.");
            return admitted(
              session.messages.react(messageId, content, emoji),
              7,
            );
          }
          case "removeReactions": {
            if (shown.reactionBusy(messageId))
              throw new Error(
                "A reaction on this message is still being sent.",
              );
            const ownEvents = new Set(
              target.reactions.flatMap((group) =>
                group.events
                  .filter((event) => event.authorId === session.viewer)
                  .map((event) => event.id),
              ),
            );
            const ids = request.args.ids;
            if (
              !Array.isArray(ids) ||
              !ids.length ||
              ids.length > 100 ||
              ids.some((id) => typeof id !== "string" || !ownEvents.has(id))
            )
              throw new Error("Only your own reactions can be removed here.");
            return admitted(session.messages.remove(ids), 5);
          }
          case "deleteMessage": {
            // Own messages, or an owned agent's with main's verified evidence
            // read again now, after any wait; never from a projected flag.
            const proof = own ? undefined : shown.authorization(messageId);
            if ((!own && !proof) || !delivered || !session.outbox?.supports(5))
              throw new Error("Only your own messages can be deleted here.");
            return admitted(session.messages.remove([messageId], proof), 5);
          }
          case "edit": {
            const { content, attachmentSourceId, baseline } = request.args;
            if (
              typeof content !== "string" ||
              content.length > 65536 ||
              typeof attachmentSourceId !== "string" ||
              typeof baseline !== "string"
            )
              throw new Error("Invalid edit.");
            if (!own || !delivered)
              throw new Error("Only your own messages can be edited.");
            // The same single-row predicate as the main menu, and the exact
            // text the companion edited: a newer edit it has not seen wins.
            if (!lastEditableMessage(session, [target]))
              throw new Error("This message is no longer available to edit.");
            if ((target.sourceContent ?? target.content) !== baseline)
              throw new Error(
                "This message changed while you were editing. Copy your changes, then cancel and reopen it.",
              );
            if (attachmentSourceId !== (target.attachmentSourceId ?? target.id))
              throw new Error("This message's attachments changed.");
            return admitted(
              session.messages.edit(messageId, content, attachmentSourceId),
              40003,
            );
          }
          case "sendToChannel": {
            if (
              !own ||
              !delivered ||
              !target.threadRootId ||
              target.agentEnvelope ||
              target.diff ||
              !session.outbox?.supports(9)
            )
              throw new Error(
                "Only your own thread replies can be sent to the channel.",
              );
            return admitted(
              session.messages.sendToChannel(target, shown.root()),
              9,
            );
          }
          case "markRead": {
            if (typeof request.args.unread !== "boolean")
              throw new Error("Invalid read state.");
            // Manual unread is main's: it also fences this window's reading leases.
            await (request.args.unread
              ? session.unread.markMessageUnread(room, messageId)
              : session.unread.markMessageRead(room, messageId));
            return;
          }
          case "report": {
            const { type, note } = request.args;
            if (!session.messages.report)
              throw new Error("Reports are unavailable on this connection.");
            if (
              typeof type !== "string" ||
              typeof note !== "string" ||
              note.length > 4096
            )
              throw new Error("Invalid report.");
            await session.messages.report(
              messageId,
              type as import("../relay/messages").ReportType,
              note,
            );
            return;
          }
        }
        return;
      }
      case "follow": {
        check();
        if (!thread) throw new Error("Not a thread.");
        if (typeof request.args.following !== "boolean")
          throw new Error("Invalid follow state.");
        session.unread.follow(room, thread, request.args.following);
        return;
      }
      case "acknowledgeOperations": {
        const ids = request.args.ids;
        if (
          !shown ||
          !Array.isArray(ids) ||
          ids.length > 256 ||
          ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{64}$/.test(id))
        )
          throw new Error("Invalid acknowledgement.");
        shown.acknowledge(ids);
        return;
      }
      case "retryOperation": {
        check(true);
        const id = request.args.id;
        if (
          !thread ||
          !shown ||
          typeof id !== "string" ||
          !/^[0-9a-f]{64}$/.test(id) ||
          !shown.retryOperation(id)
        )
          throw new Error("This change can no longer be retried here.");
        return;
      }
      case "release":
        release(request.args);
        return;
      case "agents":
        if (request.args.refresh)
          await session.agentChoices.refresh(request.args.legacy);
        else session.agentChoices.ensure(request.args.legacy === true);
        return;
      case "upload": {
        check(true);
        const file = request.args;
        if (
          !(file instanceof File) ||
          !file.size ||
          file.size > UPLOAD_MAX_BYTES ||
          uploadBytes + file.size > 2 * UPLOAD_MAX_BYTES ||
          uploaded.size >= 20
        )
          throw new Error(
            "Attachment limit reached. Send or remove files first.",
          );
        if (!session.attachments)
          throw new Error("Uploads are unavailable on this connection.");
        uploadBytes += file.size;
        try {
          const prepared = await prepareAttachment(file, signal);
          check(true);
          const result = await session.attachments.upload(
            prepared,
            room,
            signal,
          );
          signal.throwIfAborted();
          check(true);
          const key = JSON.stringify([result.url, result.sha256]);
          const previous = uploaded.get(key);
          uploaded.set(key, { file: result, uses: (previous?.uses ?? 0) + 1 });
          publish();
          return result;
        } finally {
          uploadBytes -= file.size;
        }
      }
      case "profiles":
        if (
          !Array.isArray(request.args) ||
          request.args.length > 1024 ||
          request.args.some((k) => !/^[0-9a-f]{64}$/.test(k))
        )
          throw new Error("Invalid profile request.");
        return session.profiles.ensure(request.args, "background");
      case "emoji":
        return request.args ? session.emoji.refresh() : session.emoji.ensure();
      case "archives":
        return request.args
          ? session.archives.refresh()
          : session.archives.ensure();
      case "channels":
        return request.args
          ? session.channels.refreshList?.()
          : session.channels.ensureList();
      case "people":
        if (
          typeof request.args.query !== "string" ||
          request.args.query.length > 256 ||
          !Number.isInteger(request.args.page) ||
          request.args.page < 1 ||
          request.args.page > 100
        )
          throw new Error("Invalid people search.");
        return session.directMessages.people(
          request.args.query,
          request.args.page,
          signal,
        );
      case "add":
        check(true);
        if (
          !canAddMembers(session, metadata()) ||
          !/^[0-9a-f]{64}$/.test(request.args)
        )
          throw new Error("Cannot add this person.");
        return session.memberAdditions.add(room, request.args);
      case "repositoriesHome":
        return session.repositories.home(room, signal);
      case "repositoriesLoad":
        return session.repositories.load(request.args, signal);
    }
  }
  function reset() {
    for (const controller of active.values()) controller.abort();
    active.clear();
    results.clear();
    uploaded.clear();
    gifUrls.clear();
    highest = 0;
  }
  channel.onmessage = ({ data }: MessageEvent<ComposerCommand>) => {
    if (
      closed ||
      !data ||
      typeof data.client !== "string" ||
      data.client.length > 64
    )
      return;
    if (data.kind === "hello") {
      if (client !== data.client) {
        reset();
        client = data.client;
      }
      publish();
      return;
    }
    if (data.client !== client) return;
    if (data.kind === "bye") {
      reset();
      client = "";
      return;
    }
    if (data.kind === "cancel") {
      active.get(data.id)?.abort();
      return;
    }
    if (
      data.kind !== "request" ||
      !Number.isSafeInteger(data.id) ||
      data.id < 1
    )
      return;
    const cached = results.get(data.id);
    if (cached) {
      send(cached);
      return;
    }
    if (active.has(data.id)) return;
    if (data.id <= highest || active.size >= 32) {
      send({
        kind: "result",
        client,
        id: data.id,
        error: "Composer request expired. Try again.",
      });
      return;
    }
    highest = data.id;
    const controller = new AbortController();
    active.set(data.id, controller);
    void (async () => {
      let response: ComposerResponse;
      try {
        const value = await execute(data, controller.signal);
        response = { kind: "result", client: data.client, id: data.id, value };
      } catch (cause) {
        response = {
          kind: "result",
          client: data.client,
          id: data.id,
          error: (cause instanceof Error
            ? cause.message
            : "Could not complete this request."
          ).slice(0, 2048),
        };
      }
      if (
        closed ||
        active.get(data.id) !== controller ||
        client !== data.client
      )
        return;
      active.delete(data.id);
      results.set(data.id, response);
      if (results.size > 128) results.delete(results.keys().next().value ?? 0);
      send(response);
    })();
  };
  const stops = [
    agents?.subscribe(() => {
      modelRevision += 1;
      publish();
    }),
    session.channels.subscribeList(publish),
    session.profiles.subscribe(publish),
    session.emoji.subscribe(publish),
    session.agentChoices.subscribe(publish),
    session.agentLibrary.subscribe(publish),
    session.archives.subscribe(publish),
    session.typing.subscribe(publish),
    extensions?.tools.subscribe(publish),
    extensions?.completions?.subscribe(publish),
  ];
  return {
    token,
    refresh: publish,
    dispose() {
      if (closed) return;
      send({ kind: "closed", client });
      closed = true;
      reset();
      for (const stop of stops) stop?.();
      channel.close();
    },
  };
}
