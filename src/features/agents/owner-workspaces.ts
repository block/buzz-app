// The owner tools' Solo workspace operations: the owner's private workspaces
// read and written through their own session's Solo groups and recipe kit, as
// Workspace settings writes them. Every send is admitted by the caller's live
// check, and a send that may have happened is resumed by its operation ID,
// never repeated.
import type {
  OwnerExecution,
  OwnerMutationCaller,
  OwnerWorkspace,
  OwnerWorkspaceHost,
  OwnerWorkspaceWrite,
  OwnerWriteStep,
} from "../../buzz-mcp/client";
import {
  type Resume,
  SaveRefused,
  SaveSettled,
} from "../channel-templates/capability";
import { emptyLineup, type Template } from "../channel-templates/model";
import { soloGroups } from "../relay/solo-preferences";
import {
  hasWorkspaceBlock,
  projectDefault,
  projectTemplate,
  projectTemplateId,
  readWorkspace,
  workspaceCanvas,
  workspaceDirectories,
} from "../solo/workspace";
import type { OwnerBinding } from "./owner-access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const missing = (id: string) =>
  new Error(`Your owner has no Solo workspace ${id}.`);
const edited = () =>
  new Error(
    "Your owner edited this workspace's folder instructions by hand, so only they can change its instructions, in Workspace settings. Nothing was changed.",
  );

export function createOwnerWorkspaces({
  run,
  current,
  execution,
  soloChat,
  active,
  lifetime,
}: Readonly<{
  run<T>(
    signal: AbortSignal | undefined,
    read: (binding: OwnerBinding, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  current(): OwnerBinding;
  execution(binding: OwnerBinding): OwnerExecution;
  soloChat(
    binding: OwnerBinding,
    id: string,
    signal: AbortSignal,
  ): Promise<void>;
  active(binding: OwnerBinding, caller: OwnerMutationCaller): () => boolean;
  lifetime: AbortSignal;
}>): OwnerWorkspaceHost {
  /** Workspace `id` from the owner's freshly read kit: its Solo group, the
   * groups' revision, and its own defaults record, tombstone included, which
   * owns the defaults' revision. */
  const read = async (
    binding: OwnerBinding,
    id: string,
    signal: AbortSignal,
  ) => {
    const kit = binding.session.channelKit;
    if (!kit.available)
      throw new Error("Your owner's Solo workspaces are unavailable here.");
    await kit.refresh({ after: true });
    signal.throwIfAborted();
    const state = kit.snapshot();
    if (state.status !== "ready")
      throw new Error(
        state.error ?? "Your owner's Solo workspaces are unavailable now.",
      );
    const head = soloGroups(state.entries);
    const value =
      head && !head.record.deleted && head.record.value.type === "groups"
        ? head.record.value
        : undefined;
    const templateId = await projectTemplateId(id);
    signal.throwIfAborted();
    return {
      revision: head?.eventId ?? null,
      group: value?.groups.find((group) => group.id === id),
      groups: value ?? {
        type: "groups" as const,
        id: "me" as const,
        groups: [],
        assignments: {},
      },
      assignments: value?.assignments ?? {},
      templateId,
      saved: state.entries.find(
        (entry) =>
          entry.record.value.type === "template" &&
          entry.record.value.id === templateId,
      ),
      defaults: projectDefault(state.entries, id, templateId),
    };
  };
  const groupsRevision = (binding: OwnerBinding) =>
    soloGroups(binding.session.channelKit.snapshot().entries)?.eventId ?? null;
  /** The owner's Solo groups store, loaded so it can write. */
  const groups = async (binding: OwnerBinding) => {
    const store = binding.session.soloPreferences;
    if (!store.writable) await store.refresh();
    return store;
  };
  /** One write of the owner's session, admitted only while `caller` holds.
   * Throws when it was refused before anything was sent. */
  async function write(
    caller: OwnerMutationCaller,
    workspace: string | null,
    steps: (
      binding: OwnerBinding,
      signal: AbortSignal,
      active: () => boolean,
    ) => Promise<
      Readonly<{ groups?: OwnerWriteStep; defaults?: OwnerWriteStep }>
    >,
  ): Promise<OwnerWorkspaceWrite> {
    caller.signal?.throwIfAborted();
    caller.check();
    const binding = current();
    const admitted = active(binding, caller);
    if (!admitted())
      throw new Error(
        "Your owner's Buzz is not connected to this community as them, so nothing was changed.",
      );
    const signal = AbortSignal.any([
      binding.signal,
      lifetime,
      ...(caller.signal ? [caller.signal] : []),
    ]);
    let taken: Awaited<ReturnType<typeof steps>>;
    try {
      taken = await steps(binding, signal, admitted);
    } catch (error) {
      // Steps report their own sends; anything thrown came before one.
      caller.signal?.throwIfAborted();
      if (!admitted())
        throw new Error(
          "Your owner's connection or this turn changed during the call, so nothing was changed.",
        );
      throw error;
    }
    const all = [taken.groups, taken.defaults].filter(
      (step): step is OwnerWriteStep => !!step,
    );
    const rejected = all.find((step) => step.outcome === "rejected");
    if (rejected && all.every((step) => step.outcome === "rejected"))
      throw new Error(rejected.reason);
    return {
      execution: execution(binding),
      workspace,
      outcome: all.every((step) => step.outcome === "confirmed")
        ? "confirmed"
        : all.some((step) => step.outcome === "confirmed")
          ? "partial"
          : "unconfirmed",
      ...taken,
    };
  }

  return Object.freeze({
    get: (id: string, signal?: AbortSignal) =>
      run(signal, async (binding, bound): Promise<OwnerWorkspace> => {
        const state = await read(binding, workspaceId(id), bound);
        if (!state.group) throw missing(id);
        const canvas = state.defaults?.canvas ?? "";
        let instructions: string | undefined;
        try {
          instructions = readWorkspace(canvas).canvas;
        } catch {
          instructions = undefined;
        }
        return {
          execution: execution(binding),
          workspace: id,
          name: state.group.name,
          revision: state.revision,
          defaults: {
            revision: state.saved?.eventId ?? null,
            ...(instructions !== undefined ? { instructions } : {}),
            folders: workspaceDirectories(canvas),
          },
        };
      }),
    create: ({ id, name, instructions, resume }, caller) => {
      const trimmed = name.trim();
      if (!UUID.test(id))
        throw new Error("workspace must be a lowercase UUID.");
      if (!trimmed || trimmed.length > 80)
        throw new Error("name must be 1 to 80 characters.");
      return write(caller, id, async (binding, signal, admitted) => {
        // Validated before anything is sent, as New workspace does.
        const canvas = instructions?.trim()
          ? withInstructions("", instructions)
          : "";
        const templateId = await projectTemplateId(id);
        const template = canvas
          ? projectTemplate(binding.session.scope, templateId, trimmed, {
              ...emptyLineup(),
              canvas,
            })
          : undefined;
        const store = await groups(binding);
        const state = await read(binding, id, signal);
        const groupIntent = JSON.stringify([
          "workspace.create.groups",
          id,
          trimmed,
          instructions ?? "",
        ]);
        const defaultsIntent = JSON.stringify([
          "workspace.create.defaults",
          id,
          trimmed,
          instructions ?? "",
        ]);
        const groupOperation = await binding.session.channelKit.recovery(
          state.groups,
          groupIntent,
        );
        const defaultsOperation = template
          ? await binding.session.channelKit.recovery(template, defaultsIntent)
          : undefined;
        if (resume && resume !== groupOperation && resume !== defaultsOperation)
          throw new Error(
            "That operation does not match this workspace's original intent.",
          );
        if (state.group && state.group.name !== trimmed)
          throw new Error(
            `Workspace ${id} already exists with another name. Nothing was changed.`,
          );
        if (state.saved && !same(state.saved.record, template))
          throw new Error(
            `Workspace ${id} already has other new-chat defaults. Nothing was changed.`,
          );
        if (!state.group && state.saved)
          throw new Error(
            "This workspace has retained defaults from an earlier creation. Nothing was changed.",
          );
        if (state.group && template && !state.saved && !groupOperation)
          throw new Error(
            "The original unfinished creation receipt is required to finish this workspace's defaults. Nothing was changed.",
          );
        let made: OwnerWriteStep;
        if (state.group && !groupOperation) {
          made = { outcome: "confirmed", revision: state.revision };
        } else {
          made = await saved(groupOperation, groupIntent, (resume) =>
            store
              .createSection(
                { id, name: trimmed },
                { active: admitted, signal, expected: state.revision, resume },
              )
              .then(() => groupsRevision(binding)),
          );
          if (made.outcome !== "confirmed") return { groups: made };
        }
        if (!template) return { groups: made };
        const defaults: OwnerWriteStep =
          state.saved && !defaultsOperation
            ? { outcome: "confirmed", revision: state.saved.eventId }
            : await saved(defaultsOperation, defaultsIntent, (resume) =>
                binding.session.channelKit.save(
                  template,
                  undefined,
                  false,
                  signal,
                  resume,
                  admitted,
                ),
              );
        return { groups: made, defaults };
      });
    },
    update: ({ id, revision, instructions, resume }, caller) =>
      write(caller, workspaceId(id), async (binding, signal, admitted) => {
        const state = await read(binding, id, signal);
        if (!state.group) throw missing(id);
        // As Workspace settings saves it: this workspace's own record, keeping
        // its agents, teams and folders.
        const base = state.defaults ?? emptyLineup();
        const template = projectTemplate(
          binding.session.scope,
          state.templateId,
          state.group.name,
          { ...base, canvas: withInstructions(base.canvas, instructions) },
        );
        const intent = JSON.stringify([
          "workspace.update",
          id,
          revision,
          instructions,
        ]);
        const operation =
          resume ??
          (await binding.session.channelKit.recovery(template, intent));
        const head = state.saved?.eventId ?? null;
        if (!operation && head !== revision)
          throw new Error(
            "This workspace's defaults changed since that revision; read it again. Nothing was changed.",
          );
        if (!operation && state.saved && same(state.saved.record, template))
          return { defaults: { outcome: "confirmed", revision: head } };
        return {
          defaults: await saved(operation, intent, (resume) =>
            binding.session.channelKit.save(
              template,
              state.saved?.eventId,
              false,
              signal,
              resume,
              admitted,
            ),
          ),
        };
      }),
    move: ({ chat, workspace, revision, resume }, caller) =>
      write(
        caller,
        workspace === null ? null : workspaceId(workspace),
        async (binding, signal, admitted) => {
          await soloChat(binding, chat, signal);
          const store = await groups(binding);
          const state = await read(binding, workspace ?? "", signal);
          const intent = JSON.stringify([
            "workspace.move",
            chat,
            workspace,
            revision,
          ]);
          const operation =
            resume ??
            (await binding.session.channelKit.recovery(state.groups, intent));
          if (workspace !== null && !operation && !state.group)
            throw missing(workspace);
          return {
            groups: await saved(operation, intent, (resume) =>
              store
                .assign(chat, workspace ?? undefined, signal, {
                  active: admitted,
                  signal,
                  expected: revision,
                  resume,
                })
                .then(() => groupsRevision(binding)),
            ),
          };
        },
      ),
    remove: ({ id, revision, resume }, caller) =>
      write(caller, workspaceId(id), async (binding, signal, admitted) => {
        const store = await groups(binding);
        const state = await read(binding, id, signal);
        const intent = JSON.stringify(["workspace.remove", id, revision]);
        const operation =
          resume ??
          (await binding.session.channelKit.recovery(state.groups, intent));
        // A resumed removal may already have removed it, even if its response was lost.
        if (!operation && !state.group) throw missing(id);
        // Its chats stay, outside any workspace; its defaults record stays.
        return {
          groups: await saved(operation, intent, (resume) =>
            store
              .removeSection(id, signal, {
                active: admitted,
                signal,
                expected: revision,
                resume,
              })
              .then(() => groupsRevision(binding)),
          ),
        };
      }),
  });
}

/** One saved record's result. A send that may have happened is unconfirmed,
 * with its operation ID while it can still be resumed; anything else was
 * refused before a send. */
async function saved(
  resumed: string | undefined,
  intent: string,
  save: (resume: Resume) => Promise<string | null>,
): Promise<OwnerWriteStep> {
  const resume: Resume = {
    id: resumed,
    intent,
    enqueued(id) {
      resume.id = id;
    },
  };
  try {
    return { outcome: "confirmed", revision: await save(resume) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!resume.id || error instanceof SaveRefused)
      return { outcome: "rejected", reason };
    return error instanceof SaveSettled
      ? { outcome: "unconfirmed", reason }
      : { outcome: "unconfirmed", operation: resume.id, reason };
  }
}

/** `canvas` with its instructions replaced. Its folders are the owner's to
 * choose: instructions never carry a folder block, even an incomplete one a
 * later edit could complete. */
function withInstructions(canvas: string, instructions: string) {
  if (hasWorkspaceBlock(instructions))
    throw new Error(
      "instructions cannot name workspace folders. Nothing was changed.",
    );
  let workspace: ReturnType<typeof readWorkspace>;
  try {
    workspace = readWorkspace(canvas);
  } catch {
    throw edited();
  }
  return workspaceCanvas({ ...workspace, canvas: instructions });
}

const same = (
  record: Readonly<{ deleted: boolean; value: unknown }>,
  template: Template | undefined,
) =>
  !!template &&
  !record.deleted &&
  JSON.stringify(record.value) === JSON.stringify(template);

function workspaceId(id: string) {
  if (!id || id.length > 256)
    throw new Error("workspace must be a workspace ID.");
  return id;
}
