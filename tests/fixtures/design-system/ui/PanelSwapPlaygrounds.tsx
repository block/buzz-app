import { SwapWorkspaceExperiment } from "../../../../src/shared/design-system/ui/SwapWorkspaceExperiment";
import { MultiPanelSwapExperiment } from "../../../../src/shared/design-system/ui/MultiPanelSwapExperiment";

/** Independent instances: experimenting in one section never resets another. */
export function PanelSwapPlaygrounds() {
  return (
    <>
      <section aria-label="2 panels playground">
        <h2 className="text-heading">2 panels</h2>
        <SwapWorkspaceExperiment />
      </section>
      <MultiPanelSwapExperiment count={3} />
      <MultiPanelSwapExperiment count={4} />
    </>
  );
}
