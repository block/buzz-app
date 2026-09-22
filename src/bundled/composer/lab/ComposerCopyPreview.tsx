import { useState } from "react";
import { MessageComposer } from "../../../features/messages/MessageComposer";
import { Select } from "../../../shared/design-system/ui/Select";
import { useComposerFixture } from "./fixture";

const CONTEXTS = [
  {
    group: "Channel",
    value: "channel-start",
    label: "Channel · New message",
    copy: "buzz-design",
    threadRootId: undefined,
  },
  {
    group: "Channel",
    value: "channel-reply",
    label: "Channel · Reply",
    copy: "buzz-design",
    threadRootId: "preview-thread",
  },
  {
    group: "Session",
    value: "session-reply",
    label: "Session · Reply",
    copy: "this session",
    threadRootId: "preview-session",
  },
] as const;
const GROUPS = ["Channel", "Session"].map((label) => ({
  label,
  options: CONTEXTS.filter((context) => context.group === label),
}));

export function ComposerCopyPreview() {
  const [value, setValue] = useState<string>("channel-start");
  const context =
    CONTEXTS.find((candidate) => candidate.value === value) ?? CONTEXTS[0];
  const props = useComposerFixture({
    channelName: context.copy,
    ...(context.threadRootId ? { threadRootId: context.threadRootId } : {}),
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
        <MessageComposer key={context.value} {...props} />
      </div>
    </div>
  );
}
