import type { PluginModule } from "../../plugins/api";
import type { LinkRenderer } from "../../features/conversation/contracts";
import { LinkLabel, linkKind } from "./InlineLink";
import styles from "../../shared/InlineReference.module.css";

/** The renderer this plugin registers; companion windows reuse it while main
 * has it enabled. */
export const linkRenderer: LinkRenderer = {
  id: "links",
  title: "Links",
  matches: (url) => linkKind(url) !== null,
  // Specific for recognised services and Buzz entities; a catch-all for the
  // globe case, so a dedicated renderer wins unknown hosts at the default band.
  order: (url) => (linkKind(url) === "web" ? 100 : 0),
  className: styles.link,
  component: ({ url }) => <LinkLabel href={url} />,
};

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerLink(linkRenderer);
};
