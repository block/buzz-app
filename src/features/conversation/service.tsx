// FOUNDATION: Shared conversation UI and plugin-owned tools/renderers; never another data owner.
import type { ReactNode } from "react";
import { Service, type Context } from "@deepseek-ai/cordis";
import { createContributions } from "../../plugins/contributions";
import {
  MessageComposer,
  type MessageComposerProps,
} from "../messages/MessageComposer";
import { MessageRow, type MessageRowProps } from "../messages/MessageRow";
import type {
  ComposerTool,
  InlineRenderer,
  ContributionReader,
} from "./contracts";

export type Conversation = {
  tools: ContributionReader<ComposerTool>;
  registerTool(tool: ComposerTool): void;
  inline: ContributionReader<InlineRenderer>;
  registerInline(renderer: InlineRenderer): void;
  ui: {
    Composer: (props: Omit<MessageComposerProps, "extensions">) => ReactNode;
    Message: (props: Omit<MessageRowProps, "extensions">) => ReactNode;
  };
};
declare module "@deepseek-ai/cordis" {
  interface Context {
    conversation: Conversation;
  }
}
function validate(value: ComposerTool | InlineRenderer) {
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
  readonly tools;
  readonly inline;
  private readonly toolEntries;
  private readonly inlineEntries;
  constructor(ctx: Context) {
    super(ctx, "conversation");
    const tools = createContributions<ComposerTool>(ctx);
    const inline = createContributions<InlineRenderer>(ctx);
    this.toolEntries = tools;
    this.inlineEntries = inline;
    this.tools = { snapshot: tools.snapshot, subscribe: tools.subscribe };
    this.inline = { snapshot: inline.snapshot, subscribe: inline.subscribe };
  }
  registerTool(value: ComposerTool) {
    validate(value);
    this.toolEntries.register(this.ctx, value);
  }
  registerInline(value: InlineRenderer) {
    validate(value);
    if (typeof value.matches !== "function")
      throw new Error("An inline renderer needs a matcher");
    this.inlineEntries.register(this.ctx, value);
  }
  readonly ui = {
    Composer: (props: Omit<MessageComposerProps, "extensions">) => (
      <MessageComposer {...props} extensions={this} />
    ),
    Message: (props: Omit<MessageRowProps, "extensions">) => (
      <MessageRow {...props} extensions={this} />
    ),
  };
}
