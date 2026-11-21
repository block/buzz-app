import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import {
  NoteConflict,
  noteAddress,
  noteUrl,
  noteMarkdownLink,
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
    message: noteMarkdownLink(note, community),
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
        "Working docs require this agent’s owning community to be connected.",
      );
    return value;
  }
  const community = (client: BuzzClient) =>
    workspace(client).session.scope.replace(/:[0-9a-f]{64}$/, "");
  const requireWrites = (client: BuzzClient) => {
    const value = workspace(client);
    if (!value.session.configArtifactWriter)
      throw new Error(
        "This connection does not advertise working-doc revision support.",
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
              `This request did not confirm your content as the current revision. Keep your proposed text, call page_get, merge with the latest content and retry against its revision. Current doc: ${format(error.current, community(client))}`,
            );
          throw error;
        }
      },
    };
  }
  return [
    tool(
      "page_help",
      "Create document deliverables as live Docs instead of attaching .md files. Start here for the create/verify/link/update workflow, Docs plugin links, reading and updating shared docs, revision conflicts, permissions, or missing tools. Use page_* tools for these docs; Canvas and published notes_* tools read different content.",
      {},
      [],
      async () => agentGuide,
    ),
    tool(
      "page_get",
      "Read a working doc from its Docs plugin URL, or id and channel. Search accessible docs by title with q, or omit arguments to list. Search/listing are paged; keep q and pass the returned cursor. Results include links and revisions for page_set. For guidance use page_help. Published agent notes still use notes_get.",
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
              "Read a doc address or search/list docs, not both.",
            );
          const linked =
            args.url === undefined
              ? undefined
              : parseNoteUrl(string(args, "url"));
          if (
            args.url !== undefined &&
            (!linked || args.id !== undefined || args.channel !== undefined)
          )
            throw new Error("Provide one valid doc URL, or id and channel.");
          if (linked && linked.community !== origin)
            throw new Error(
              `This doc belongs to ${linked.community}; this agent is connected to ${origin}. Ask from the doc’s community.`,
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
            .filter(
              (note) =>
                !note.deleted && note.title.toLowerCase().includes(query),
            )
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
      "Create or edit a live Markdown document; prefer this to .md attachments unless a file is requested. The result’s message is a ready-to-post Doc link. Verify with page_get, then reply using that link. To create, omit channel/revision and reuse a new UUID id on retries; only the owner and creating agent receive access. Ask the owner to use Share doc if someone else needs access. To edit, use channel/revision from page_get; on conflict read, merge and retry. Restore deleted docs with page_delete restore:true. Pass text or a UTF-8 path.",
      { ...addressFields, revision: str, title: str, text: str, path: str },
      ["id", "title"],
      async (client, _context, args) => {
        requireWrites(client);
        if (args.revision !== undefined && args.channel === undefined)
          throw new Error(
            "Editing requires channel and id from page_get together with revision. Omit revision only when creating a new doc.",
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
            "This doc is deleted. Read page_history for retained title/content, then use page_delete with restore:true, the current revision, title and text to restore it.",
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
      "Read retained revisions of a connected doc. Access is the same as the current doc; offset pages are 100 revisions. To restore an older version, read it, then page_set its contents against the current revision.",
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
      "Soft-delete or restore a connected doc using its current revision. Restoring requires a title and Markdown text. The backing channel and sharing are retained.",
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
  ];
}
