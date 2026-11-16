// Prebuilt API v1 module: no build, dependencies, network or filesystem access.
// Uses the host's own controls from the optional `ui` service, with plain
// elements as the fallback on hosts that do not provide it.
export const inject = ["react", "pages"];

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  ctx.pages.register({
    id: "main",
    title: "Host controls playground",
    primary: true,
    component: function HostControls() {
      const ui = ctx.reflect.get("ui");
      const [open, setOpen] = React.useState(false);
      const [name, setName] = React.useState("");
      const [draft, setDraft] = React.useState("");
      const [alerts, setAlerts] = React.useState(false);
      const intro = h(
        "p",
        null,
        name
          ? `Saved as ${name}, alerts ${alerts ? "on" : "off"}.`
          : "Nothing saved yet.",
      );
      if (!ui)
        return h(
          "section",
          { style: { padding: "var(--space-panel-inset)" } },
          h("h1", null, "Host controls playground"),
          h("p", null, "This version of Buzz does not offer host controls."),
          intro,
        );
      const edit = () => {
        setDraft(name);
        setOpen(true);
      };
      const save = () => {
        setName(draft.trim());
        setOpen(false);
      };
      return h(
        "section",
        { style: { padding: "var(--space-panel-inset)" } },
        h("h1", null, "Host controls playground"),
        intro,
        h(ui.Button, { variant: "prominent", onClick: edit }, "Edit profile"),
        h(
          ui.Dialog,
          {
            open,
            onOpenChange: setOpen,
            title: "Profile",
            description:
              "Try typing, Tab, Escape, and disabling the plugin while this is open.",
            actions: [
              h(
                ui.Button,
                { key: "cancel", onClick: () => setOpen(false) },
                "Cancel",
              ),
              h(
                ui.Button,
                {
                  key: "save",
                  variant: "prominent",
                  disabled: !draft.trim(),
                  onClick: save,
                },
                "Save",
              ),
            ],
          },
          h(
            ui.Field,
            {
              label: "Display name",
              error: draft.trim() ? undefined : "Enter a name",
            },
            h(ui.Input, {
              value: draft,
              onValueChange: setDraft,
              autoFocus: true,
            }),
          ),
          h(ui.Switch, {
            label: "Desktop alerts",
            checked: alerts,
            onCheckedChange: setAlerts,
          }),
        ),
      );
    },
  });
}
