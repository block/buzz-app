import type { PluginModule } from "../../plugins/api";
import { voiceRecorderTool } from "./recorder-tool";
import { VoiceNoteCard } from "./VoiceNoteCard";
import { isVoiceNoteAttachment } from "./audio";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerTool(voiceRecorderTool);
  ctx.conversation.registerAttachment({
    id: "player",
    title: "Voice note",
    matches: (attachment) =>
      attachment.voiceNote === true ||
      isVoiceNoteAttachment({
        m: attachment.mime ?? "",
        filename: attachment.name ?? "",
      }),
    component: ({ attachment, source, onRemove }) => (
      <VoiceNoteCard
        source={source}
        downloadName={attachment.name ?? ""}
        {...(attachment.duration === undefined
          ? {}
          : { duration: attachment.duration })}
        {...(attachment.waveform ? { waveform: attachment.waveform } : {})}
        {...(onRemove ? { onRemove } : {})}
      />
    ),
  });
};
