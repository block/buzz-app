import { useRef, useState } from "react";
import { ArrowsOutIcon, CopyIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MermaidDiagram } from "./MermaidDiagram";
import { writeClipboardText } from "../../shared/clipboard";
import {
  CopyLabel,
  CopyStatus,
  useCopyFeedback,
} from "../../shared/CopyFeedback";

/** Opens a complex diagram at full size, with its source a click away. */
export function MermaidExpand({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const expand = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        hint="familiar"
        ref={expand}
        aria-label="Expand diagram"
        title="Expand diagram"
        icon={<ArrowsOutIcon />}
        onClick={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Mermaid diagram"
        size="expanded"
        closeLabel="Close diagram"
        finalFocus={expand}
        leadingActions={<CopyCode code={code} />}
      >
        <MermaidDiagram code={code} expanded />
      </Dialog>
    </>
  );
}

/** The dialog's Copy code button, which shows its own result. It mounts with
 * the dialog, so a refusal it is still showing does not outlast a close. */
function CopyCode({ code }: { code: string }) {
  const [copying, setCopying] = useState(false);
  const { attempted, copied, failed, copy } = useCopyFeedback();
  return (
    <>
      <Button
        aria-label="Copy code"
        disabled={copying}
        onClick={() => {
          setCopying(true);
          void copy(() => writeClipboardText(code)).then(() =>
            setCopying(false),
          );
        }}
      >
        <CopyLabel
          label="Copy code"
          icon={<CopyIcon size={16} aria-hidden="true" />}
          copied={copied}
          failed={failed}
        />
      </Button>
      {attempted && <CopyStatus copied={copied} failed={failed} />}
    </>
  );
}
