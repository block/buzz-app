import { useState } from "react";
import { MessageComposer } from "../../../features/messages/MessageComposer";
import { composerPlaceholder } from "../../../features/messages/composer-placeholder";
import { Select } from "../../../shared/design-system/ui/Select";
import { useComposerFixture } from "./fixture";

const CONTEXTS = [
  {
    group: "Channel",
    value: "channel-start",
    label: "Channel · New message",
    destination: "channel",
    hasMessages: false,
  },
  {
    group: "Channel",
    value: "channel-reply",
    label: "Channel · Reply",
    destination: "channel",
    hasMessages: true,
  },
  {
    group: "Thread",
    value: "thread-start",
    label: "Thread · New thread",
    destination: "thread",
    hasMessages: false,
  },
  {
    group: "Thread",
    value: "thread-reply",
    label: "Thread · Reply",
    destination: "thread",
    hasMessages: true,
  },
  {
    group: "Direct message",
    value: "dm-start",
    label: "Direct message · New message",
    destination: "dm",
    hasMessages: false,
  },
  {
    group: "Direct message",
    value: "dm-reply",
    label: "Direct message · Reply",
    destination: "dm",
    hasMessages: true,
  },
] as const;
const GROUPS = ["Channel", "Thread", "Direct message"].map((label) => ({
  label,
  options: CONTEXTS.filter((context) => context.group === label),
}));

export function ComposerCopyPreview() {
  const [value, setValue] = useState<string>("channel-start");
  const context =
    CONTEXTS.find((candidate) => candidate.value === value) ?? CONTEXTS[0];
  const props = useComposerFixture({
    channelName: "buzz-design",
    ...(context.destination === "thread"
      ? { threadRootId: "preview-thread" }
      : {}),
    placeholder: composerPlaceholder(
      context.destination,
      context.hasMessages,
      "buzz-design",
    ),
  });
  return (
    <div className="product-specimen">
      <Select
        label="Preview context"
        value={value}
        groups={GROUPS}
        onValueChange={setValue}
      />
      <div className="composer-playground-stage">
        <MessageComposer key={context.destination} {...props} />
      </div>
    </div>
  );
}
