import { Fragment } from "react";
import type { PluginModule } from "../../plugins/api";
import type { PanelProps } from "../../features/panels/service";
import {
  profilePanelKey,
  profileActivityViewKey,
} from "../../features/profiles/target";
import { ProfilePanel, type PersonProfileInfoContent } from "./ProfilePanel";

export const inject = [
  "panels",
  "relay",
  "navigation",
  "agents",
  "communityReader",
  "conversation",
];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.panels.register({
    id: "profile",
    title: "Profile",
    matches: (target) =>
      !!profilePanelKey(target) || !!profileActivityViewKey(target),
    component: Object.assign(
      (props: PanelProps & PersonProfileInfoContent) => (
        <ProfilePanel
          {...props}
          renderPersonFields={(context) =>
            context.managed
              ? renderManagedFields(context)
              : props.renderPersonFields?.(context)
          }
          relay={ctx.relay}
          navigation={ctx.navigation}
          agents={ctx.agents}
          communities={ctx.communityReader}
          linkRenderers={ctx.conversation.links}
        />
      ),
      { supportsPersonInfoContent: true, supportsPersonFields: true },
    ),
  });
};

function renderManagedFields({
  managed: data,
  section,
  renderRow,
}: Parameters<NonNullable<PersonProfileInfoContent["renderPersonFields"]>>[0]) {
  if (!data) return null;
  const rows = data.fields.filter(
    (field) =>
      field.section === section &&
      field.key !== "username" &&
      field.key !== "timezone",
  );
  if (!rows.length) return null;
  return (
    <>
      {rows.map(({ key, label, value, username: target }) => (
        <Fragment key={key}>
          {renderRow(label, value || "Not set", value ? target : undefined)}
        </Fragment>
      ))}
    </>
  );
}
