import type { PluginModule } from "../../plugins/api";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";

export const inject = ["pages"];

export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "reviews",
    title: "Reviews",
    layout: "workspace",
    primary: true,
    placement: "sidebar",
    component: ReviewsPage,
  });
};

function ReviewsPage() {
  return (
    <FullPageSurface aria-label="Reviews">
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader title={<PanelHeaderLabel title="Reviews" />} />
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <p className="text-body text-standard">Hello, world!</p>
        </div>
      </div>
    </FullPageSurface>
  );
}
