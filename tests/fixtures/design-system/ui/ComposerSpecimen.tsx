import { useState } from "react";

import {
  AtIcon,
  FileTextIcon,
  SmileyIcon,
  XIcon,
} from "../../../../src/shared/design-system/icons/index";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { Composer } from "../../../../src/shared/design-system/ui/Composer";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";

function Tools({ disabled = false }: { disabled?: boolean }) {
  return (
    <>
      <IconButton
        aria-label="Add emoji"
        icon={<SmileyIcon size={20} aria-hidden="true" />}
        size="toolbar"
        disabled={disabled}
      />
      <IconButton
        aria-label="Mention a member"
        icon={<AtIcon size={20} aria-hidden="true" />}
        size="toolbar"
        disabled={disabled}
      />
    </>
  );
}

function LiveComposer() {
  const [value, setValue] = useState("");
  const [sent, setSent] = useState(false);

  return (
    <Composer
      label="Interactive message"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        setSent(false);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        setValue("");
        setSent(true);
      }}
      tools={<Tools />}
      status={sent ? "Message sent in this local preview." : undefined}
    />
  );
}

export function ComposerSpecimen() {
  const [draft, setDraft] = useState(
    "The component page now covers the complete message flow.",
  );
  const [multiline, setMultiline] = useState(
    "First line of the reply.\nA second line shows how the frame grows.",
  );
  const [recovered, setRecovered] = useState(false);

  return (
    <div className="component-specimen-stack composer-specimen-stack">
      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Interactive · empty, drafting and submitted
        </h2>
        <div className="component-specimen-frame composer-specimen-frame">
          <LiveComposer />
        </div>
      </section>

      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">Draft ready to send</h2>
        <div className="component-specimen-frame composer-specimen-frame">
          <Composer
            label="Draft message"
            value={draft}
            onValueChange={setDraft}
            tools={<Tools />}
          />
        </div>
      </section>

      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Multiline reply · contextual media time
        </h2>
        <div className="component-specimen-frame composer-specimen-frame">
          <Composer
            label="Thread reply"
            placeholder="Reply to thread"
            rows={3}
            value={multiline}
            onValueChange={setMultiline}
            tools={<Tools />}
            context={
              <>
                <span className="composer-specimen-context-label">
                  <FileTextIcon size={16} aria-hidden="true" />
                  Commenting at 01:42
                </span>
                <IconButton
                  aria-label="Remove video time"
                  icon={<XIcon size={14} aria-hidden="true" />}
                  size="compact"
                />
              </>
            }
          />
        </div>
      </section>

      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Sending · draft and actions are locked
        </h2>
        <div className="component-specimen-frame composer-specimen-frame">
          <Composer
            label="Sending message"
            value="Sending the latest design notes…"
            onValueChange={() => undefined}
            tools={<Tools disabled />}
            sending
            status="Adding agent to this channel…"
          />
        </div>
      </section>

      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Failed preparation · recovery stays adjacent
        </h2>
        <div className="component-specimen-frame composer-specimen-frame">
          <Composer
            label="Message with error"
            value="Share the BlockUI comparison."
            onValueChange={() => undefined}
            tools={<Tools />}
            status={recovered ? "Message preparation recovered." : undefined}
            error={
              recovered ? undefined : (
                <span className="composer-specimen-recovery">
                  Custom emoji could not be prepared.
                  <Button size="sm" onClick={() => setRecovered(true)}>
                    Retry
                  </Button>
                </span>
              )
            }
          />
        </div>
      </section>

      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Disabled · history or membership is unavailable
        </h2>
        <div className="component-specimen-frame composer-specimen-frame">
          <Composer
            label="Unavailable message"
            value=""
            onValueChange={() => undefined}
            placeholder="Messaging is unavailable"
            tools={<Tools disabled />}
            disabled
            status="Reconnect to continue this conversation."
          />
        </div>
      </section>

      <section className="component-specimen-group">
        <h2 className="text-body-sm text-tertiary">
          Narrow · tools and send remain reachable
        </h2>
        <div className="component-specimen-frame composer-specimen-frame">
          <div className="composer-specimen-narrow">
            <Composer
              label="Narrow message"
              value="A compact draft"
              onValueChange={() => undefined}
              tools={<Tools />}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
