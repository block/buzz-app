// Local-only diagnostic controls; production component in development StrictMode.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AttachmentImage } from "../../src/features/messages/AttachmentImage";
import styles from "../../src/features/messages/Messages.module.css";
import "../../src/shared/styles/globals.css";

const failed = "https://image.test/failed.svg";
const blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
// Failed frames across the geometries a message reserves: single previews,
// small and extreme aspect ratios, and compact grids at two widths.
const failureFrames = [
  ["single preview", { width: 1200, height: 500 }],
  ["short preview", { width: 1200, height: 300 }],
  ["small square", { width: 88, height: 88 }],
  ["narrow square", { width: 80, height: 80 }],
  ["tiny square", { width: 48, height: 48 }],
  ["wide strip", { width: 1200, height: 40 }],
  ["tall strip", { width: 100, height: 4000 }],
] as const;

function FailureSizes() {
  return (
    <section aria-label="Failure sizes">
      {failureFrames.map(([name, dimensions]) => (
        <div key={name} data-failure-frame={name}>
          <AttachmentImage
            attachment={{ url: failed, kind: "image", blurhash, dimensions }}
            source={failed}
          />
        </div>
      ))}
      {[
        ["grid", "22.5rem"],
        ["narrow grid", "12rem"],
      ].map(([name, width]) => (
        <div
          key={name}
          data-failure-frame={name}
          className={`${styles.imageList} ${styles.imageGrid}`}
          style={{ width }}
        >
          {[0, 1, 2, 3].map((index) => (
            <AttachmentImage
              key={index}
              attachment={{ url: failed, kind: "image", blurhash }}
              source={failed}
              compact
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function Fixture() {
  const [source, setSource] = useState("first");
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [hash, setHash] = useState<string | undefined>(blurhash);
  const [failures, setFailures] = useState(false);
  const url = `https://image.test/${source}.svg`;
  return (
    <>
      <button type="button" onClick={() => setVisible(true)}>
        Reveal
      </button>
      <button type="button" onClick={() => setSource("next")}>
        Retarget
      </button>
      <button type="button" onClick={() => setSource("first")}>
        Restore original
      </button>
      <button type="button" onClick={() => setSource("failed")}>
        Fail original
      </button>
      <button type="button" onClick={() => setMounted(!mounted)}>
        Toggle mount
      </button>
      <button type="button" onClick={() => setHash(undefined)}>
        No hash
      </button>
      <button type="button" onClick={() => setHash("invalid")}>
        Invalid hash
      </button>
      <button type="button" onClick={() => setFailures(true)}>
        Failure sizes
      </button>
      {failures && <FailureSizes />}
      <div style={{ marginTop: visible ? 20 : 2000 }}>
        {mounted && (
          <AttachmentImage
            attachment={{
              url,
              kind: "image",
              ...(hash ? { blurhash: hash } : {}),
            }}
            url={url}
            source={url}
            onOpenLink={() => false}
          />
        )}
      </div>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
