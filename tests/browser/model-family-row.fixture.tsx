// An Agent setup harness row: a compact family ModelPicker with an effort.
import { createRoot } from "react-dom/client";
import { ModelPicker } from "../../src/features/agents/ModelPicker";
import { PreferenceRow } from "../../src/shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../src/shared/design-system/ui/SettingsGroup";
import "../../src/shared/styles/globals.css";

const efforts = [
  { id: "", label: "Automatic" },
  { id: "low", label: "Low" },
  { id: "high", label: "High" },
];
const width = Number(new URLSearchParams(location.search).get("width"));

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");

createRoot(root).render(
  <div style={{ width }}>
    <SettingsGroup>
      <PreferenceRow
        title="Claude"
        trailing={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body-sm text-subtle">Default model</span>
            <ModelPicker
              includeDefault={false}
              compact
              groupByFamily
              label="Claude default model"
              models={[
                { id: "opus", label: "Opus 5.5", efforts },
                { id: "sonnet", label: "Sonnet 5.5", efforts },
              ]}
              value="opus"
              effort="low"
              effortLabel="Low"
              onEffortChange={() => undefined}
              defaultLabel="Claude default"
              onChange={() => undefined}
            />
          </div>
        }
      />
    </SettingsGroup>
  </div>,
);
