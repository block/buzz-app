import { Button } from "../../shared/design-system/ui/Button";

/**
 * Pause after creating, replacing or importing a key. None may upload
 * silently: the backup is offered, and the key continues either way. The key
 * may be used elsewhere, so the copy discloses that Block can restore it there
 * too; choosing Back it up is the backup consent.
 */
export function BackupOffer({
  onSkip,
  onBackUp,
}: {
  onSkip: () => void;
  onBackUp: () => void;
}) {
  return (
    <>
      <div>
        <h1
          id="welcome-title"
          tabIndex={-1}
          className="text-heading text-standard"
        >
          Back up your key?
        </h1>
        <p className="mt-2 text-body text-subtle">
          Save an encrypted copy of your private key online with your Builderlab
          account. You can use it when setting up Buzz on another device.
        </p>
        <p className="mt-2 text-body text-subtle">
          Block can use that copy to restore this key, including anywhere else
          you use it.
        </p>
      </div>
      {/* Footer order: secondary first, primary last. */}
      <div data-onboarding-actions="">
        <Button size="lg" onClick={onSkip}>
          Not now
        </Button>
        <Button size="lg" variant="prominent" onClick={onBackUp}>
          Back it up
        </Button>
      </div>
    </>
  );
}
