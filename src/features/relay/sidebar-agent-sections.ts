import type { RelaySession } from "./session";

const SECTIONABLE = new Set([undefined, "stream", "forum"]);

/** The owner's sidebar sections in `session`, for their agents. Each write
 * goes through the same queued, confirmed preference writes as the sidebar. */
export function sidebarSections(
  session: RelaySession,
  steward: () => Promise<boolean>,
) {
  const preferences = session.sidebarPreferences;
  const stewarding = async () => {
    if (!(await steward()))
      throw new Error(
        "Only your owner's Bestie can arrange their sidebar sections. Ask it to.",
      );
  };
  const loaded = async () => {
    if (!preferences.writable) await preferences.ensure();
    if (!preferences.writable) await preferences.refresh();
    const data = preferences.snapshot().data;
    if (!data || !preferences.writable)
      throw new Error("Your sidebar sections couldn't be read. Try again.");
    return data;
  };
  const channels = () => session.channels.list().channels;
  const sectionable = (ref: string) => {
    const all = channels();
    const key = ref.replace(/^#/, "").toLowerCase();
    const byName = all.filter((item) => item.name.toLowerCase() === key);
    const channel =
      all.find((item) => item.id === ref) ??
      (byName.length === 1 ? byName[0] : undefined);
    if (byName.length > 1 && !channel)
      throw new Error(`More than one channel is named ${ref}; use its id.`);
    if (!channel) throw new Error(`You aren't in channel ${ref}.`);
    if (channel.archived || !SECTIONABLE.has(channel.channelType))
      throw new Error(`${channel.name} can't go in a section.`);
    return channel;
  };
  const existing = async (id: string) => {
    const section = (await loaded()).sections.find((item) => item.id === id);
    if (!section) throw new Error(`No section ${id}.`);
    return section;
  };
  const named = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("A section needs a name.");
    if ([...trimmed].length > 256)
      throw new Error("A section name can be at most 256 characters.");
    return trimmed;
  };
  return {
    async list() {
      const data = await loaded();
      const names = new Map(channels().map((item) => [item.id, item.name]));
      const channel = (id: string) => ({ id, name: names.get(id) ?? "" });
      return {
        sections: [...data.sections]
          .sort((a, b) => a.order - b.order)
          .map(({ id, name }) => ({
            id,
            name,
            channels: Object.entries(data.assignments)
              .filter(([, section]) => section === id)
              .map(([channelId]) => channel(channelId)),
          })),
        starred: data.starred.map(channel),
      };
    },
    async create(name: string) {
      await stewarding();
      const section = { id: crypto.randomUUID(), name: named(name) };
      await loaded();
      if (!preferences.sectionCreationWritable)
        throw new Error("Sections can't be created right now. Try again.");
      try {
        await preferences.createSection(section);
      } catch (error) {
        // The relay may have accepted it before confirmation failed.
        const saved = preferences.snapshot().data?.sections;
        if (!saved?.some((item) => item.id === section.id)) throw error;
      }
      return section;
    },
    async rename(id: string, name: string) {
      await stewarding();
      const next = named(name);
      await existing(id);
      await preferences.renameSection(id, next);
    },
    async remove(id: string) {
      await stewarding();
      await existing(id);
      await preferences.removeSection(id);
    },
    async assign(channelId: string, sectionId: string | undefined) {
      await stewarding();
      const channel = sectionable(channelId);
      if (sectionId === undefined) await loaded();
      else await existing(sectionId);
      await preferences.assign(channel.id, sectionId);
    },
  };
}
