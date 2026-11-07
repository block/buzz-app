import { MediaMenuDownloadProvider } from "../../src/features/messages/MediaDownloadAction";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AttachmentImage } from "../../src/features/messages/AttachmentImage";
import { UpdateNotice } from "../../src/features/updates/UpdateNotice";
import { createUpdates } from "../../src/features/updates/updates";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

// Real notice/updater owners and the plain MediaViewer path. Only native update
// I/O is fake; no download, installation, restart or live relay access occurs.
let finishDownload: () => void;
const download = new Promise<void>((resolve) => {
  finishDownload = resolve;
});
const report = { installs: 0, restarts: 0 };
const updates = createUpdates({
  desktop: true,
  check: async () => ({
    version: "1.2.3",
    download: () => download,
    install: async () => {
      report.installs++;
    },
    close: async () => {},
  }),
  relaunch: async () => {
    report.restarts++;
  },
});
Object.assign(window, { finishDownload: () => finishDownload(), report });
window.addEventListener("pagehide", () => updates.dispose());
const root = document.getElementById("root");
const toastRoot = document.getElementById("buzz-toast-root");
if (!root || !toastRoot) throw new Error("Missing fixture hosts");
createRoot(root).render(
  <StrictMode>
    <ToastProvider portalContainer={toastRoot}>
      <MediaMenuDownloadProvider>
        <AttachmentImage
          attachment={{
            url: "/shell-gradient.png",
            kind: "image",
            name: "Notice isolation image",
          }}
          source="/shell-gradient.png"
        />
      </MediaMenuDownloadProvider>
      <div inert>Other inert content remains visible</div>
      <UpdateNotice updates={updates} />
    </ToastProvider>
  </StrictMode>,
);
