import type { PluginModule } from "../../plugins/api";

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "projects",
    title: "Projects",
    layout: "workspace",
    component: ProjectsPage,
  });
};

function ProjectsPage() {
  return (
    <section
      aria-label="Projects"
      className="flex h-full min-h-0 items-center justify-center rounded-3xl border border-line bg-surface p-6 text-center shadow-surface"
    >
      <h1 className="m-0 text-3xl font-medium tracking-tight">Projects</h1>
    </section>
  );
}
