import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { TabSlot, useTabNodes } from "../../src/bundled/channels/TabHosts";
import { PanelWorkspace } from "../../src/features/panels/PanelWorkspace";
import { PanelDock } from "../../src/features/panels/PanelDock";
import { RetainedWorkspacePresentation } from "../../src/features/panels/WorkspacePresentation";
import { MediaAttachment } from "../../src/features/messages/MediaAttachment";
import "../../src/shared/styles/globals.css";

function Player() {
  return (
    <div style={{ width: 320 }}>
      <MediaAttachment
        attachment={{
          kind: "video",
          url: new URL("./message-gallery/assets/sample.mp4", import.meta.url)
            .href,
          mime: "video/mp4",
        }}
        media={(url) => url}
        mode="thread"
      />
    </div>
  );
}

function Workspace() {
  const [main, setMain] = useState(true);
  const [selected, select] = useState("player");
  const [closed, close] = useState(false);
  const nodes = useTabNodes(closed ? [] : ["player"]);
  const node = nodes.get("player");
  const items = node
    ? [
        { id: "player", label: "Player", content: <TabSlot node={node} /> },
        {
          id: "other",
          label: "Other",
          close() {},
          content: <p>Other content</p>,
        },
      ]
    : [];
  const pane = (
    <PanelWorkspace
      main={main}
      items={items}
      value={selected}
      select={select}
    />
  );
  return (
    <>
      <button type="button" onClick={() => setMain(!main)}>
        Move player
      </button>
      <button type="button" onClick={() => close(true)}>
        Close player
      </button>
      <div style={{ display: "flex", height: 500 }}>
        <section aria-label="Main pane" style={{ width: 400, display: "flex" }}>
          {main && pane}
        </section>
        <PanelDock open={!main} className={undefined}>
          {!main && (
            <section
              aria-label="Side pane"
              style={{ width: 400, display: "flex", height: 500 }}
            >
              {pane}
            </section>
          )}
        </PanelDock>
      </div>
      {node &&
        createPortal(
          <RetainedWorkspacePresentation target={node}>
            <Player />
          </RetainedWorkspacePresentation>,
          node,
        )}
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
createRoot(root).render(<Workspace />);
