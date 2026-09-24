import type { PluginModule } from "../../plugins/api";
import { TemplateEditor, GroupDefault } from "./TemplateEditor";
import { TemplateSettings, SaveAsTemplate } from "./TemplateSettings";
export const inject = ["relay", "settingsCards", "channelTemplates"];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  ctx.settingsCards.register({
    id: "templates",
    title: "Templates & teams",
    component: ({ active }) => (
      <TemplateSettings relay={relay} active={active} />
    ),
  });
  ctx.channelTemplates.register({
    id: "templates",
    title: "Templates & teams",
    editor: TemplateEditor,
    groupDefault: GroupDefault,
    saveAs: SaveAsTemplate,
  });
};
