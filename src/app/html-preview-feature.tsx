import { FileCodeIcon } from "../shared/design-system/icons/index";
import { HtmlPreviewPanel } from "../features/html-preview/HtmlPreviewPanel";
import {
  htmlAttachmentTarget,
  isHtmlAttachment,
  joinedRelayOrigins,
  parseHtmlPreviewTarget,
} from "../features/html-preview/target";
import type { PluginModule } from "../plugins/api";

const tabIcon = () => <FileCodeIcon size="1rem" />;

export const inject = [
  "panels",
  "browser",
  "conversation",
  "communityReader",
  "relay",
];

export const apply: PluginModule["apply"] = (ctx) => {
  if (!ctx.browser.available) return;
  // Cordis wraps service functions on access; keep React's component identity.
  const View = ctx.browser.View;
  const origins = () =>
    joinedRelayOrigins(ctx.communityReader.snapshot(), ctx.relay.selected?.());

  ctx.panels.register({
    id: "html-preview",
    title: "HTML preview",
    tabIcon,
    keepOpen: true,
    matches: (target) => !!parseHtmlPreviewTarget(target, origins()),
    component: ({ target }) => (
      <HtmlPreviewPanel target={target} origins={origins} View={View} />
    ),
  });

  ctx.conversation.registerAttachment({
    id: "html-preview",
    title: "HTML preview",
    matches: (attachment) => isHtmlAttachment(attachment),
    component: ({ attachment, source, canOpen, open, FileCard }) => {
      if (!FileCard) return null;
      const previewTarget = htmlAttachmentTarget(source, attachment.name);
      const canPreview =
        !!previewTarget &&
        !!parseHtmlPreviewTarget(previewTarget, origins()) &&
        canOpen(previewTarget);
      return (
        <FileCard
          attachment={attachment}
          source={source}
          onOpenLink={open}
          onPreview={
            canPreview
              ? () => {
                  open(previewTarget);
                }
              : undefined
          }
          typeLabel="HTML"
        />
      );
    },
  });
};
