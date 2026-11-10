import { useEffect, useMemo, useState } from "react";
import type { PanelProps } from "../../features/panels/service";
import {
  CaretLeftIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Select } from "../../shared/design-system/ui/Select";
import { DiffViewer } from "../diffs/DiffViewer";
import { parsePatch } from "../diffs/parse";
import type { ChangedFile } from "./git";
import { parseTarget } from "./target";
import type { Turns } from "./turns";
import { Counts, plural, totals } from "./Counts";
import styles from "./Changesets.module.css";

type Patch = { text: string } | { error: string } | undefined;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A recorded turn's checkout: its files, one diff at a time. */
export function ChangesetPanel({
  target,
  turns,
}: Pick<PanelProps, "target"> & { turns: Turns }) {
  const link = useMemo(() => parseTarget(target), [target]);
  const found = link && turns.find(link.turn, link.checkout);
  const [listed, setListed] = useState<{
    files?: ChangedFile[];
    error?: string;
  }>({});
  const [chosen, setChosen] = useState(link?.file);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setChosen(link?.file), [link?.file]);
  useEffect(() => {
    if (!link) return;
    let live = true;
    setListed({});
    turns.summary(link.turn, link.checkout).then(
      (files) => live && setListed({ files }),
      (error) => live && setListed({ error: message(error) }),
    );
    return () => {
      live = false;
    };
  }, [turns, link]);
  const files = listed.files;
  const index = files
    ? Math.max(
        0,
        files.findIndex((file) => file.path === chosen),
      )
    : 0;
  const file = files?.[index];
  const [patch, setPatch] = useState<Patch>();
  useEffect(() => {
    setPatch(undefined);
    if (!link || !file || file.binary) return;
    let live = true;
    // Retried by changing `attempt`.
    void attempt;
    turns.patch(link.turn, link.checkout, file).then(
      (text) => live && setPatch({ text }),
      (error) => live && setPatch({ error: message(error) }),
    );
    return () => {
      live = false;
    };
  }, [turns, link, file, attempt]);
  const parsed = useMemo(
    () => (patch && "text" in patch ? parsePatch(patch.text) : undefined),
    [patch],
  );
  if (!link || !found)
    return <p role="alert">This changeset was recorded in another Buzz.</p>;
  const pending = !listed.error && !files;
  const step = (by: number) => files && setChosen(files[index + by]?.path);
  return (
    <div className={styles.panel}>
      <InlineHeader
        level={3}
        title={found.checkout.label}
        subtitle={
          files ? (
            <>
              {plural(files.length, "file")} changed{" "}
              <Counts {...totals(files)} />
            </>
          ) : undefined
        }
      />
      <LoadingRegion
        pending={pending}
        label="Reading the changes…"
        feedback={
          listed.error ? (
            <p role="alert">Couldn't read this changeset. {listed.error}</p>
          ) : undefined
        }
      >
        {files && file && (
          <>
            {files.length > 1 && (
              <div className={styles.picker}>
                <Select
                  label="File"
                  variant="compact"
                  value={file.path}
                  onValueChange={setChosen}
                  groups={[
                    {
                      label: "Changed files",
                      options: files.map((each) => ({
                        value: each.path,
                        label: each.path,
                      })),
                    },
                  ]}
                />
                <IconButton
                  aria-label="Previous file"
                  icon={<CaretLeftIcon size={16} aria-hidden="true" />}
                  disabled={index === 0}
                  onClick={() => step(-1)}
                />
                <IconButton
                  aria-label="Next file"
                  icon={<CaretRightIcon size={16} aria-hidden="true" />}
                  disabled={index === files.length - 1}
                  onClick={() => step(1)}
                />
              </div>
            )}
            <FileDiff
              file={file}
              patch={patch}
              parsed={parsed}
              retry={() => setAttempt(attempt + 1)}
            />
          </>
        )}
      </LoadingRegion>
    </div>
  );
}

function FileDiff({
  file,
  patch,
  parsed,
  retry,
}: {
  file: ChangedFile;
  patch: Patch;
  parsed: ReturnType<typeof parsePatch>;
  retry(): void;
}) {
  if (file.binary)
    return <p className="text-body-sm">Binary file: no text diff to show.</p>;
  if (!patch) return <p className="text-body-sm">Reading {file.path}…</p>;
  if ("error" in patch)
    return (
      <div role="alert">
        <p className="text-body-sm">{patch.error}</p>
        <Button size="sm" variant="ghost" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  return (
    <DiffViewer content={patch.text} files={parsed} filePath={file.path} />
  );
}
