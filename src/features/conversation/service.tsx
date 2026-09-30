// FOUNDATION: Shared conversation UI and plugin-owned tools/renderers; never another data owner.
import type { ReactNode } from "react";
import { EmbeddedThread, type EmbeddedThreadProps } from "./EmbeddedThread";
import { Service, type Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import {
  MessageComposer,
  type MessageComposerProps,
} from "../messages/MessageComposer";
import { MessageRow, type MessageRowProps } from "../messages/MessageRow";
import {
  formatDayGroupLabel,
  formatFullTimestamp,
  formatItemTimestamp,
} from "../../shared/datetime";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import type {
  ChannelThreadDirectory,
  ComposerTool,
  ComposerAccessory,
  ComposerCompletion,
  InlineRenderer,
  LinkRenderer,
  MessageRenderer,
  ContributionReader,
} from "./contracts";

export type Conversation = {
  messages: ContributionReader<MessageRenderer>;
  registerMessage(renderer: MessageRenderer): void;
  channelDirectories: ContributionReader<ChannelThreadDirectory>;
  registerChannelDirectory(directory: ChannelThreadDirectory): void;
  accessories: ContributionReader<ComposerAccessory>;
  registerAccessory(accessory: ComposerAccessory): void;
  tools: ContributionReader<ComposerTool>;
  registerTool(tool: ComposerTool): void;
  completions: ContributionReader<ComposerCompletion>;
  registerCompletion(provider: ComposerCompletion): void;
  inline: ContributionReader<InlineRenderer>;
  registerInline(renderer: InlineRenderer): void;
  links: ContributionReader<LinkRenderer>;
  registerLink(renderer: LinkRenderer): void;
  ui: {
    Thread: (props: EmbeddedThreadProps) => ReactNode;
    Composer: (
      props: Omit<
        MessageComposerProps,
        "extensions" | "startCommand" | "registerDraft"
      >,
    ) => ReactNode;
    Message: (props: Omit<MessageRowProps, "extensions">) => ReactNode;
  };
  /** The host's date labels, so plugin text reads like the message rows. */
  format: {
    /** "9:05 AM", "Yesterday", "Monday", "Sat, Jun 20", "Jun 20, 2025";
     * `withTime` appends " at 9:05 AM" outside today. */
    itemTimestamp: typeof formatItemTimestamp;
    /** The day divider: "Today", "Yesterday", "Monday", "Saturday, June 20",
     * "June 20, 2025". */
    dayGroupLabel: typeof formatDayGroupLabel;
    /** The hover text on a byline: "Friday, October 2, 2026 at 3:05:09 PM EDT". */
    fullTimestamp: typeof formatFullTimestamp;
    /** Link previews: "just now", "5 minutes ago", "3 days ago", "on Jun 20". */
    relativeTimestamp: typeof relativeTimestamp;
  };
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    conversation: Conversation;
  }
}
function validate(
  value:
    | ChannelThreadDirectory
    | ComposerTool
    | InlineRenderer
    | ComposerCompletion
    | ComposerAccessory
    | LinkRenderer
    | MessageRenderer,
) {
  if (
    !value ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(value.id) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.component !== "function"
  )
    throw new Error(
      "A conversation contribution needs an id, title and component",
    );
}
export class ConversationService extends Service implements Conversation {
  readonly messages;
  private readonly messageEntries;
  readonly channelDirectories;
  private readonly directoryEntries;
  readonly tools;
  readonly accessories;
  private readonly accessoryEntries;
  readonly completions;
  private readonly completionEntries;
  readonly inline;
  private readonly toolEntries;
  private readonly inlineEntries;
  readonly links;
  private readonly linkEntries;
  constructor(ctx: Context) {
    super(ctx, "conversation");
    const messages = createContributions<MessageRenderer>(ctx);
    this.messageEntries = messages;
    this.messages = {
      snapshot: messages.snapshot,
      subscribe: messages.subscribe,
    };
    const directories = createContributions<ChannelThreadDirectory>(ctx);
    this.directoryEntries = directories;
    this.channelDirectories = {
      snapshot: directories.snapshot,
      subscribe: directories.subscribe,
    };
    const accessories = createContributions<ComposerAccessory>(ctx);
    this.accessoryEntries = accessories;
    this.accessories = {
      snapshot: accessories.snapshot,
      subscribe: accessories.subscribe,
    };
    const tools = createContributions<ComposerTool>(ctx);
    const completions = createContributions<ComposerCompletion>(ctx);
    this.completionEntries = completions;
    this.completions = {
      snapshot: completions.snapshot,
      subscribe: completions.subscribe,
    };
    const inline = createContributions<InlineRenderer>(ctx);
    this.toolEntries = tools;
    this.inlineEntries = inline;
    this.tools = { snapshot: tools.snapshot, subscribe: tools.subscribe };
    this.inline = { snapshot: inline.snapshot, subscribe: inline.subscribe };
    const links = createContributions<LinkRenderer>(ctx);
    this.linkEntries = links;
    this.links = { snapshot: links.snapshot, subscribe: links.subscribe };
  }
  registerMessage(value: MessageRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("A message renderer needs a matcher");
    this.messageEntries.register(this.ctx, value);
  }
  registerChannelDirectory(value: ChannelThreadDirectory) {
    validate(value);
    if (
      value.create !== undefined &&
      (!value.create ||
        typeof value.create.title !== "string" ||
        !value.create.title.trim() ||
        typeof value.create.component !== "function")
    )
      throw new Error("A channel draft needs a title and component");
    if (value.sidebar !== undefined && typeof value.sidebar !== "function")
      throw new Error("A channel sidebar contribution needs a component");
    if (
      value.threadAccessory !== undefined &&
      typeof value.threadAccessory !== "function"
    )
      throw new Error("A channel thread accessory needs a component");
    this.directoryEntries.register(this.ctx, value);
  }
  registerAccessory(value: ComposerAccessory) {
    validate(value);
    this.accessoryEntries.register(this.ctx, value);
  }
  registerTool(value: ComposerTool) {
    validate(value);
    this.toolEntries.register(this.ctx, value);
  }
  registerCompletion(value: ComposerCompletion) {
    validate(value);
    if (typeof value.match !== "function")
      throw new Error("A completion provider needs a matcher");
    this.completionEntries.register(this.ctx, value);
  }
  registerInline(value: InlineRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("An inline renderer needs a matcher");
    this.inlineEntries.register(this.ctx, value);
  }
  registerLink(value: LinkRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("A link renderer needs a matcher");
    if (value.className !== undefined && typeof value.className !== "string")
      throw new Error("A link renderer class must be a string");
    this.linkEntries.register(this.ctx, value);
  }
  readonly format = Object.freeze({
    itemTimestamp: formatItemTimestamp,
    dayGroupLabel: formatDayGroupLabel,
    fullTimestamp: formatFullTimestamp,
    relativeTimestamp,
  });
  readonly ui = {
    Thread: (props: EmbeddedThreadProps) => (
      <EmbeddedThread {...props} host={this.ctx} extensions={this} />
    ),
    Composer: (
      props: Omit<
        MessageComposerProps,
        "extensions" | "startCommand" | "registerDraft"
      >,
    ) => (
      <MessageComposer
        {...props}
        extensions={this}
        startCommand={undefined}
        registerDraft={undefined}
      />
    ),
    Message: (props: Omit<MessageRowProps, "extensions">) => (
      <MessageRow {...props} extensions={this} />
    ),
  };
}
