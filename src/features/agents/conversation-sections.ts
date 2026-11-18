// The base prompt sections a plugin replaced for one agent in one
// conversation: the plugin that holds this record manages the conversation.
// It is kept on this device, keyed as harnesses key the conversation's
// session. A turn's prompt uses it only while that plugin is on and its
// manifest declares the section, which the host checks when it builds the
// prompt.
import { pluginSection } from "../agent-harness/sections";
import {
  SECTION_TEXT_BYTES,
  textProblem,
} from "../agent-harness/sections/choices";
import type { AgentKey } from "./membership";
import type { AgentStore } from "./store";

export const CONVERSATION_SECTIONS_PREFIX =
  "buzz.agents.conversation-sections.v1:";
/** The most UTF-8 bytes one conversation's texts have together. */
export const CONVERSATION_SECTIONS_BYTES = 12 * 1024;
const storageKey = (scope: string, agent: AgentKey, conversation: string) =>
  `${CONVERSATION_SECTIONS_PREFIX}${JSON.stringify([scope, agent, conversation])}`;

/** Section ID → the plugin's text for it. */
type Texts = Readonly<Record<string, string>>;
export type ConversationSections = Readonly<{
  plugin: string;
  sections: Texts;
}>;

const bytes = (text: string) => new TextEncoder().encode(text).length;
/** The current IDs of the sections a manifest's `declared` names. */
const named = (declared: readonly string[]) =>
  new Set(declared.map((id) => pluginSection(id)?.id));

/** `sections` as they are kept: each under its section's current ID, with
 * its text trimmed. Rejects a section a plugin cannot replace, one that
 * `declared`, the plugin's manifest, does not name, and a text or a set that
 * cannot be used. */
export function checkedSections(
  sections: Texts,
  declared: readonly string[],
): Texts {
  if (!sections || typeof sections !== "object" || Array.isArray(sections))
    throw new Error("Conversation sections are section IDs with their text");
  const allowed = named(declared);
  const checked: Record<string, string> = {};
  for (const [id, value] of Object.entries(sections)) {
    const section = pluginSection(id);
    if (!section)
      throw new Error(
        `A plugin cannot replace the agent prompt section "${id}"`,
      );
    if (!allowed.has(section.id))
      throw new Error(
        `The plugin's manifest does not declare the agent prompt section "${id}"`,
      );
    const text = typeof value === "string" ? value.trim() : "";
    if (!text)
      throw new Error(
        `The section "${id}" needs text: a plugin cannot turn a section off`,
      );
    if (bytes(text) > SECTION_TEXT_BYTES)
      throw new Error(
        `The text for the section "${id}" is over ${SECTION_TEXT_BYTES} bytes`,
      );
    if (textProblem(text))
      throw new Error(
        `The text for the section "${id}" has control characters`,
      );
    checked[section.id] = text;
  }
  if (bytes(Object.values(checked).join("")) > CONVERSATION_SECTIONS_BYTES)
    throw new Error(
      `Conversation sections are over ${CONVERSATION_SECTIONS_BYTES} bytes`,
    );
  return checked;
}

/** The conversation's record; undefined when it has none or it cannot be
 * read. */
export function conversationSections(
  store: Pick<AgentStore, "get">,
  scope: string,
  agent: AgentKey,
  conversation: string,
): ConversationSections | undefined {
  const saved = store.get(storageKey(scope, agent, conversation));
  if (!saved) return undefined;
  try {
    const { plugin, sections } = JSON.parse(
      saved,
    ) as Partial<ConversationSections>;
    if (
      typeof plugin === "string" &&
      sections &&
      typeof sections === "object" &&
      Object.values(sections).every((text) => typeof text === "string")
    )
      return { plugin, sections };
  } catch {
    // Unreadable, as if it had none.
  }
  return undefined;
}

/** The record's texts that a prompt may use now: those `declared`, the
 * manifest of the plugin that is on, still names. */
export function usableSections(
  { sections }: ConversationSections,
  declared: readonly string[],
): Texts {
  const allowed = named(declared);
  return Object.fromEntries(
    Object.entries(sections).flatMap(([id, text]) => {
      const section = pluginSection(id);
      return section && allowed.has(section.id) && !textProblem(text)
        ? [[section.id, text] as const]
        : [];
    }),
  );
}

/** Replaces the conversation's record with `sections`, which `plugin` gave;
 * none removes it. */
export async function setConversationSections(
  store: AgentStore,
  scope: string,
  agent: AgentKey,
  conversation: string,
  plugin: string,
  sections: Texts,
) {
  await store.set(
    storageKey(scope, agent, conversation),
    Object.keys(sections).length ? JSON.stringify({ plugin, sections }) : null,
  );
}

/** Drops every conversation's record for the agent, in every scope. A
 * failure only warns: it must not stop the agent's removal. */
export async function forgetConversationSections(
  store: AgentStore,
  agent: AgentKey,
) {
  const keys = store.keys().filter((key) => {
    if (!key.startsWith(CONVERSATION_SECTIONS_PREFIX)) return false;
    try {
      return (
        (
          JSON.parse(key.slice(CONVERSATION_SECTIONS_PREFIX.length)) as string[]
        )[1] === agent
      );
    } catch {
      return false;
    }
  });
  await Promise.all(keys.map((key) => store.set(key, null))).catch((error) =>
    console.warn("Conversation sections were not removed", error),
  );
}
