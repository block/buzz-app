import { useRef, useState, useMemo, type ReactNode } from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import {
  UploadError,
  type UploadedAttachment,
} from "../../../features/relay/attachments";
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
function Attachments() {
  const props = useComposerFixture();
  const [pending, setPending] = useState(0);
  const requests = useRef(
    new Map<
      symbol,
      { file: File; settle(result: UploadedAttachment | UploadError): void }
    >(),
  );
  const session = useMemo(
    () => ({
      ...props.session,
      attachments: {
        upload(file: File, _channel: string, signal: AbortSignal) {
          return new Promise<UploadedAttachment>((resolve, reject) => {
            const key = Symbol();
            const abort = () => settle(new UploadError("cancelled"));
            const settle = (result: UploadedAttachment | UploadError) => {
              signal.removeEventListener("abort", abort);
              requests.current.delete(key);
              setPending(requests.current.size);
              if (result instanceof UploadError) reject(result);
              else resolve(result);
            };
            requests.current.set(key, { file, settle });
            signal.addEventListener("abort", abort, { once: true });
            setPending(requests.current.size);
            if (signal.aborted) abort();
          });
        },
      },
    }),
    [props.session],
  );
  const complete = (fail: boolean) => {
    for (const { file, settle } of [...requests.current.values()])
      settle(
        fail
          ? new UploadError("metadata")
          : {
              url: `https://preview.invalid/media/${"a".repeat(64)}.txt`,
              sha256: "a".repeat(64),
              size: file.size,
              type: file.type || "application/octet-stream",
            },
      );
  };
  return (
    <>
      <MessageComposer {...props} session={session} />
      <div className="product-specimen-actions">
        <Button disabled={!pending} onClick={() => complete(false)}>
          Complete example upload
        </Button>
        <Button disabled={!pending} onClick={() => complete(true)}>
          Reject example upload
        </Button>
      </div>
    </>
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
            title="File selection"
            description="Choose files with the paperclip to review local previews and removal. Uploads and sends are simulated here; selected files never leave this device. In the app, files upload on selection; removing one excludes it from the message but does not delete the server copy. Unsent attachments clear when leaving the conversation."
          >
            <Attachments />
          </Example>
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
