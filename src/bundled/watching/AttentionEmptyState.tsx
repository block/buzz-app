import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { AttentionSonar } from "./AttentionSonar";

export function AttentionEmptyState({
  name,
  picture,
  active,
}: {
  name: string;
  picture?: string | undefined;
  active: boolean;
}) {
  return (
    <section aria-label="Start watching">
      <EmptyState
        icon={
          <AttentionSonar name={name} picture={picture} size="large" hints />
        }
        title="Attention"
        description={`Attention lets ${name} watch for messages and updates across Buzz, then act or notify you based on your instructions.${active ? ` Send ${name} a message to get started.` : ""}`}
      />
    </section>
  );
}
