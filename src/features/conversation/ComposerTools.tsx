import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerTool,
  ComposerToolProps,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

export function ComposerTools({
  registry,
  ...props
}: ComposerToolProps & {
  registry: ContributionReader<ComposerTool>;
}) {
  const tools = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  return tools.map((tool) => (
    <ContributionBoundary
      key={contributionKey(tool)}
      fallback={<span role="status">{tool.title} unavailable</span>}
    >
      <OwnedTool tool={tool} registry={registry} {...props} />
    </ContributionBoundary>
  ));
}
function OwnedTool({
  tool,
  registry,
  ...props
}: ComposerToolProps & {
  tool: Contribution<ComposerTool>;
  registry: ContributionReader<ComposerTool>;
}) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const [commands, setCommands] =
    useState<Pick<ComposerToolProps, "insertText" | "focus">>();
  useLayoutEffect(() => {
    let live = true;
    const active = () =>
      live && registry.snapshot().includes(tool) && !current.current.disabled;
    setCommands({
      insertText: (text) =>
        active() ? current.current.insertText(text) : false,
      focus: () => {
        if (active()) current.current.focus();
      },
    });
    return () => {
      live = false;
    };
  }, [tool, registry]);
  const Tool = tool.component;
  return commands ? <Tool {...props} {...commands} /> : null;
}
