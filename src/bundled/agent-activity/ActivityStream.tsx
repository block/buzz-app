import { useMemo, useState } from "react";
import type { ActivityRecord } from "../../features/agents/activity-records";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { activityTranscript, type TranscriptEntry } from "./transcript";
import {
  activityCategory,
  activityPresentation,
} from "./activity-presentation";

/** Presentation of the caller's scoped capture, never a second activity store. */
export function ActivityStream({
  records,
}: {
  records: readonly ActivityRecord[];
}) {
  const transcript = useMemo(() => activityTranscript(records), [records]);
  const latest = (entry: TranscriptEntry) =>
    Math.max(
      ...entry.sourceIds.map(
        (id) => transcript.sourceOrder.get(id) ?? -Infinity,
      ),
    );
  const entries = transcript.groups
    .flatMap((group) => group.entries)
    .sort((a, b) => latest(b) - latest(a));
  const operations = entries.filter(
    (entry) => activityCategory(entry) === "operation",
  );
  const communication = entries.filter(
    (entry) => activityCategory(entry) === "communication",
  );
  const diagnostics = entries.filter(
    (entry) => activityCategory(entry) === "diagnostic",
  );
  const items = (rows: TranscriptEntry[]) =>
    rows.map((entry) => {
      const presentation = activityPresentation(entry);
      return {
        value: entry.id,
        title: `${presentation.title}${presentation.target ? ` · ${presentation.target}` : ""}${presentation.shellOutput?.failed || entry.status === "failed" ? " · Failed" : entry.status === "pending" ? " · Last reported pending" : entry.status === "in_progress" ? " · Last reported running" : ""}`,
        content: (
          <div className="flex min-w-0 flex-col gap-2">
            {entry.body && (
              <div className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-body-sm">
                {entry.body}
              </div>
            )}
            {entry.input && (
              <div>
                <p className="text-caption">
                  {presentation.command ? "Command" : "Input"}
                </p>
                <pre className="max-h-96 overflow-auto text-mono">
                  <code>{presentation.command ?? entry.input}</code>
                </pre>
              </div>
            )}
            {entry.output && (
              <div>
                <p className="text-caption">Output</p>
                <pre className="max-h-96 overflow-auto text-mono">
                  <code>
                    {presentation.shellOutput
                      ? [
                          presentation.shellOutput.stdout,
                          presentation.shellOutput.stderr,
                          presentation.shellOutput.note,
                        ]
                          .filter(Boolean)
                          .join("\n") || "No text output."
                      : entry.output}
                  </code>
                </pre>
              </div>
            )}
            <RawSource entry={entry} transcript={transcript} />
          </div>
        ),
      };
    });
  return (
    <section
      aria-label="Readable activity"
      className="flex min-w-0 flex-col gap-2"
    >
      {transcript.omitted > 0 && (
        <p role="status" className="text-caption">
          Older activity is outside this display window.
        </p>
      )}
      {operations.length ? (
        <Accordion variant="activity" items={items(operations)} />
      ) : (
        <p className="text-body-sm">No tool activity captured yet.</p>
      )}
      <Accordion
        variant="activity"
        items={[
          ...(communication.length
            ? [
                {
                  value: "communication",
                  title: `Progress and responses (${communication.length})`,
                  content: (
                    <Accordion
                      variant="activity"
                      items={items(communication)}
                    />
                  ),
                },
              ]
            : []),
          ...(diagnostics.length
            ? [
                {
                  value: "diagnostics",
                  title: `Diagnostics (${diagnostics.length})${diagnostics.some((entry) => /error/i.test(entry.title)) ? " · Error reported" : ""}`,
                  content: (
                    <Accordion variant="activity" items={items(diagnostics)} />
                  ),
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}

function RawSource({
  entry,
  transcript,
}: {
  entry: TranscriptEntry;
  transcript: ReturnType<typeof activityTranscript>;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  return (
    <Accordion
      variant="activity"
      value={expanded}
      onValueChange={setExpanded}
      items={[
        {
          value: "source",
          title: "Raw source",
          content: expanded.length ? (
            <div>
              {entry.sourceIds.map((id) => {
                const source = transcript.source(id);
                return source ? (
                  <pre key={id} className="max-h-96 overflow-auto text-mono">
                    <code>{source.plaintext}</code>
                  </pre>
                ) : null;
              })}
            </div>
          ) : null,
        },
      ]}
    />
  );
}
