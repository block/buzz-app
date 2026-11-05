import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { eventDto } from "../relay/events";
import {
  memberAuthority,
  memberChangeConfirmed,
} from "../channel-members/administration-protocol";
import {
  NoteConflict,
  NOTE_KIND,
  independentNoteStorage,
  noteTag,
  noteAddress,
  noteUrl,
  parseNoteUrl,
  readNote,
  readNoteHistory,
  saveNote,
  type Note,
  type NoteRead,
} from "./model";
import { readNotesPage, type NotesWorkspace } from "./workspace";
import agentGuide from "./agent-guide.md?raw";

const str = { type: "string" };
const addressFields = { id: str, channel: str };
const string = (args: Record<string, unknown>, key: string) => {
  if (typeof args[key] !== "string") throw new Error(`${key} is required.`);
  return args[key] as string;
};
const asReader =
  (client: BuzzClient): NoteRead =>
  (filters) =>
    client.query(filters);
const format = (note: Note, community: string) =>
  JSON.stringify({
    id: note.id,
    channel: note.channel,
    revision: note.revision,
    title: note.title,
    deleted: note.deleted,
    link: noteUrl(note, community),
    markdown: note.markdown,
  });

/** Reads and content writes always use the caller's custody/relay connection.
 * The owner's coordinator allocates new storage and admits only the verified creating agent. */
export function noteTools(
  current: (client: BuzzClient) => NotesWorkspace | undefined,
): AddedTool[] {
  function workspace(client: BuzzClient) {
    const value = current(client);
    if (
      !value ||
      value.session.viewer !== client.owner ||
      value.session.relayAuthor !== client.relayAuthor
    )
      throw new Error(
        "Working pages require this agent’s owning community to be connected.",
      );
    return value;
  }
  const community = (client: BuzzClient) =>
    workspace(client).session.scope.replace(/:[0-9a-f]{64}$/, "");
  const requireWrites = (client: BuzzClient) => {
    const value = workspace(client);
    if (!value.session.configArtifactWriter)
      throw new Error(
        "This connection does not advertise working-page revision support.",
      );
    return value;
  };
  function tool(
    name: string,
    description: string,
    properties: Record<string, object>,
    required: string[],
    call: AddedTool["call"],
  ): AddedTool {
    return {
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      async call(client, context, args) {
        try {
          return await call(client, context, args);
        } catch (error) {
          if (error instanceof NoteConflict)
            throw new Error(
              `This request did not confirm your content as the current revision. Keep your proposed text, call page_get, merge with the latest content and retry against its revision. Current page: ${format(error.current, community(client))}`,
            );
          throw error;
        }
      },
    };
  }
  return [
    tool(
      "page_help",
      "Learn to use Pages. Start here for buzz://page or legacy buzz://note links, reading and updating shared pages, revision conflicts, permissions, or missing tools. Use page_* tools for these pages; Canvas and published notes_* tools read different content.",
      {},
      [],
      async () => agentGuide,
    ),
    tool(
      "page_get",
      "Read a working page from its buzz://page or legacy buzz://note URL, or id and channel. Search accessible pages by title with q, or omit arguments to list. Search/listing are paged; keep q and pass the returned cursor. Results include links and revisions for page_set. For guidance use page_help. Published agent notes still use notes_get.",
      {
        ...addressFields,
        url: str,
        q: str,
        cursor: {
          type: "object",
          properties: { until: { type: "integer" }, before_id: str },
          required: ["until", "before_id"],
          additionalProperties: false,
        },
      },
      [],
      async (client, _context, args) => {
        const origin = community(client);
        if (
          args.url !== undefined ||
          args.id !== undefined ||
          args.channel !== undefined
        ) {
          if (args.q !== undefined || args.cursor !== undefined)
            throw new Error(
              "Read a page address or search/list pages, not both.",
            );
          const linked =
            args.url === undefined
              ? undefined
              : parseNoteUrl(string(args, "url"));
          if (
            args.url !== undefined &&
            (!linked || args.id !== undefined || args.channel !== undefined)
          )
            throw new Error("Provide one valid page URL, or id and channel.");
          if (linked && linked.community !== origin)
            throw new Error(
              `This page belongs to ${linked.community}; this agent is connected to ${origin}. Ask from the page’s community.`,
            );
          const address = linked ?? noteAddress(args);
          return format(await readNote(asReader(client), address), origin);
        }
        if (
          args.q !== undefined &&
          (typeof args.q !== "string" || args.q.length > 512)
        )
          throw new Error("Use a title query of at most 512 characters.");
        const query =
          typeof args.q === "string" ? args.q.trim().toLowerCase() : "";
        const page = await readNotesPage(
          asReader(client),
          client.pubkey,
          client.relayAuthor ?? "",
          args.cursor as Parameters<typeof readNotesPage>[3],
        );
        return JSON.stringify({
          pages: page.notes
            .filter((note) => note.title.toLowerCase().includes(query))
            .map((note) => ({
              id: note.id,
              channel: note.channel,
              revision: note.revision,
              title: note.title,
              deleted: note.deleted,
              link: noteUrl(note, origin),
            })),
          more: page.more,
          ...(page.more ? { cursor: page.cursor } : {}),
        });
      },
    ),
    tool(
      "page_set",
      "Create or edit a Markdown page. To create, omit channel/revision and reuse a new UUID id on retries; only the owner and creating agent receive access. The owner shares or grants Admin in Share page; page_share requires Admin. To edit, use channel/revision from page_get; on conflict read, merge and retry. Restore deleted pages with page_delete restore:true. Pass text or a UTF-8 path.",
      { ...addressFields, revision: str, title: str, text: str, path: str },
      ["id", "title"],
      async (client, _context, args) => {
        requireWrites(client);
        if (args.revision !== undefined && args.channel === undefined)
          throw new Error(
            "Editing requires channel and id from page_get together with revision. Omit revision only when creating a new page.",
          );
        if ((args.text === undefined) === (args.path === undefined))
          throw new Error("Provide exactly one of text or path.");
        const markdown =
          args.path === undefined
            ? string(args, "text")
            : new TextDecoder("utf-8", { fatal: true }).decode(
                await client.read(string(args, "path")),
              );
        const draft = { title: string(args, "title"), markdown };
        if (args.channel === undefined) {
          const value = workspace(client);
          const note = await value.create(
            { ...draft, id: string(args, "id"), agent: client.pubkey },
            undefined,
            (template) => client.publish(template),
          );
          return format(note, community(client));
        }
        const address = noteAddress(args);
        const read = asReader(client);
        const base = await readNote(read, address);
        if (base.revision !== string(args, "revision"))
          throw new NoteConflict(base);
        if (base.deleted)
          throw new Error(
            "This page is deleted. Read page_history for retained title/content, then use page_delete with restore:true, the current revision, title and text to restore it.",
          );
        return format(
          await saveNote(
            read,
            (template) => client.publish(template),
            base,
            draft,
          ),
          community(client),
        );
      },
    ),
    tool(
      "page_history",
      "Read retained revisions of a connected page. Access is the same as the current page; offset pages are 100 revisions. To restore an older version, read it, then page_set its contents against the current revision.",
      {
        ...addressFields,
        offset: { type: "integer", minimum: 0, maximum: 10000 },
      },
      ["id", "channel"],
      async (client, _context, args) =>
        JSON.stringify(
          await readNoteHistory(
            asReader(client),
            noteAddress(args),
            args.offset === undefined ? 0 : Number(args.offset),
          ),
        ),
    ),
    tool(
      "page_delete",
      "Soft-delete or restore a connected page using its current revision. Restoring requires a title and Markdown text. The backing channel and sharing are retained.",
      {
        ...addressFields,
        revision: str,
        restore: { type: "boolean" },
        title: str,
        text: str,
      },
      ["id", "channel", "revision"],
      async (client, _context, args) => {
        requireWrites(client);
        const read = asReader(client),
          base = await readNote(read, noteAddress(args));
        if (base.revision !== string(args, "revision"))
          throw new NoteConflict(base);
        const restore = args.restore === true;
        const draft = restore
          ? { title: string(args, "title"), markdown: string(args, "text") }
          : { title: base.title, markdown: "" };
        return format(
          await saveNote(
            read,
            (template) => client.publish(template),
            base,
            draft,
            restore ? "restore" : "delete",
          ),
          community(client),
        );
      },
    ),
    tool(
      "page_share",
      "Explicitly give a person/agent read or edit access to a connected page, or remove them. Requires the calling agent’s channel administration permission; never borrows the owner’s authority. Readers receive retained history too.",
      {
        ...addressFields,
        pubkey: str,
        access: { type: "string", enum: ["read", "edit", "remove"] },
      },
      ["id", "channel", "pubkey", "access"],
      async (client, _context, args) => {
        const address = noteAddress(args);
        await readNote(asReader(client), address);
        const pubkey = string(args, "pubkey"),
          access = string(args, "access");
        if (
          !/^[0-9a-f]{64}$/.test(pubkey) ||
          !["read", "edit", "remove"].includes(access)
        )
          throw new Error("Invalid sharing request.");
        const state = async () => {
          const events = (
            await client.query(
              [39000, 39001, 39002].map((kind) => ({
                kinds: [kind],
                authors: [client.relayAuthor],
                "#d": [address.channel],
                limit: 1,
                consistency: "strong",
              })),
            )
          ).map(eventDto);
          const metadata = events.find(
            (event) =>
              event.kind === 39000 &&
              event.pubkey === client.relayAuthor &&
              noteTag(event, "d") === address.channel,
          );
          if (!independentNoteStorage(address, metadata))
            throw new Error("This page does not use independent page sharing.");
          return {
            metadata,
            authority: memberAuthority(
              events,
              address.channel,
              client.pubkey,
              client.relayAuthor ?? "",
            ),
          };
        };
        const before = await state();
        if (!before.authority.canManage)
          throw new Error(
            "This agent needs Admin access to administer page sharing. Ask the owner to open Share page and grant this agent Admin. Creating or editing a page does not grant administration.",
          );
        if (
          pubkey === client.pubkey ||
          before.authority.roles[pubkey] === "owner"
        )
          throw new Error(
            "page_share cannot change this agent’s own or the owner’s access.",
          );
        const heads = await client.query([
          {
            kinds: [NOTE_KIND],
            "#h": [address.channel],
            limit: 2,
            consistency: "strong",
          },
        ]);
        if (
          heads.length !== 1 ||
          !heads[0] ||
          noteTag(heads[0], "d") !== address.id
        )
          throw new Error(
            "This storage contains other pages. Create a separate working copy before sharing this page.",
          );
        const role = access === "read" ? "guest" : "member";
        await client.publish({
          kind: access === "remove" ? 9001 : 9000,
          content: "",
          tags: [
            ["h", address.channel],
            ["p", pubkey],
            ...(access === "remove" ? [] : [["role", role]]),
          ],
        });
        const after = await state();
        if (
          !memberChangeConfirmed(after.authority, {
            pubkey,
            expectedRole: before.authority.roles[pubkey] ?? "absent",
            role: access === "remove" ? "remove" : role,
          })
        )
          throw new Error(
            "Sharing was not confirmed. Read access before retrying.",
          );
        return "Page access updated.";
      },
    ),
  ];
}
