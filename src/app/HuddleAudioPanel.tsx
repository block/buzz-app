import styles from "./DeveloperSettings.module.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { Button } from "../shared/design-system/ui/Button";
import { InlineHeader } from "../shared/design-system/ui/Header";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../shared/design-system/ui/SwitchPreferenceRow";
import { huddleAudio, type AudioReport } from "../features/huddle/diagnostics";
import { nativeHuddleStats } from "../features/huddle/bridge";
import { writeClipboardText } from "../shared/clipboard";

async function read(reset = false): Promise<AudioReport> {
  if (reset) huddleAudio.reset();
  const native = isTauri()
    ? await nativeHuddleStats(reset).catch(() => ({}))
    : {};
  return { ...huddleAudio.report(), ...native };
}

/** Live Huddle audio counts at each hop, and the agent playback switch. */
export function HuddleAudioPanel() {
  const playback = useSyncExternalStore(
    huddleAudio.subscribe,
    huddleAudio.playback,
  );
  const [report, setReport] = useState<AudioReport>({});
  useEffect(() => {
    let alive = true;
    const update = () =>
      void read().then((next) => {
        if (alive) setReport(next);
      });
    update();
    const timer = setInterval(update, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const rows = Object.entries(report).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section aria-labelledby="huddle-audio-title" className="space-y-2">
      <div className={styles.metricsHeader}>
        <InlineHeader
          id="huddle-audio-title"
          title="Huddle audio"
          subtitle="Frame counts, gaps and decoded Codex channel levels, updated every second. No audio is kept."
          actions={
            <div className={styles.actions}>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  void writeClipboardText(
                    JSON.stringify({ playback, at: new Date(), report }),
                  )
                }
              >
                Copy report
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void read(true).then(setReport)}
              >
                Reset
              </Button>
            </div>
          }
        />
      </div>
      <SettingsGroup layout="form">
        <SwitchPreferenceRow
          label="Play Codex voice on this speaker"
          description="An agent hosted here plays its decoded Codex voice straight to this device instead of sending it through the relay. Others in the Huddle won’t hear it."
          checked={playback === "local"}
          onCheckedChange={(local) =>
            huddleAudio.setPlayback(local ? "local" : "relay")
          }
        />
        {rows.length ? (
          <section
            className={styles.history}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard panning of audio counts.
            tabIndex={0}
            aria-label="Huddle audio counts"
          >
            <table className="text-body-sm tabular-nums">
              <tbody>
                {rows.map(([stage, counters]) => (
                  <tr key={stage}>
                    <th scope="row">{stage}</th>
                    <td>
                      {Object.entries(counters)
                        .map(([name, value]) => `${name} ${value}`)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <p role="status" className="m-0 text-body-sm text-muted">
            Join a Huddle to see counts.
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}
