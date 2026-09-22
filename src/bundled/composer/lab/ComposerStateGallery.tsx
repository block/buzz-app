import type { ReactNode } from "react";
import { MessageComposer } from "../../../features/messages/MessageComposer";
import { ComposerCopyPreview } from "./ComposerCopyPreview";
import { useComposerFixture } from "./fixture";

function Example({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="product-specimen" aria-label={title}>
      <div className="product-specimen-heading">
        <h3 className="text-body font-semibold text-primary">{title}</h3>
        <p className="text-body-sm text-tertiary">{description}</p>
      </div>
      {children}
    </section>
  );
}
function Unavailable() {
  const props = useComposerFixture({ disabled: true });
  return <MessageComposer {...props} />;
}
function ReadOnly() {
  const props = useComposerFixture();
  const session = {
    ...props.session,
    outbox: undefined,
  } as unknown as typeof props.session;
  return <MessageComposer {...props} session={session} />;
}
function ValidationError() {
  const props = useComposerFixture({ initialDraft: "Retry this message" });
  const session = {
    ...props.session,
    messages: {
      ...props.session.messages,
      send: () => {
        throw new Error("Example delivery failed. Your message is still here.");
      },
    },
  } as typeof props.session;
  return <MessageComposer {...props} session={session} />;
}
export function ComposerStateGallery() {
  return (
    <>
      <section className="product-section" aria-label="Composer playground">
        <ComposerCopyPreview />
      </section>
      <section className="product-section" aria-label="States">
        <div className="product-section-heading">
          <h2 className="text-heading text-primary">States</h2>
          <p className="text-body text-secondary">
            Hard-to-reach states of the same production composer.
          </p>
        </div>
        <div className="product-specimens">
          <Example
            title="Unavailable"
            description="Writing and sending are disabled in this conversation."
          >
            <Unavailable />
          </Example>
          <Example
            title="Read only"
            description="This connection can read but cannot send messages."
          >
            <ReadOnly />
          </Example>
          <Example
            title="Validation and recovery"
            description="A rejected send leaves the draft intact so the person can retry."
          >
            <ValidationError />
          </Example>
        </div>
      </section>
    </>
  );
}
