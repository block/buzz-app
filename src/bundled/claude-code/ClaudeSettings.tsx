import { useCallback, useEffect, useRef, useState } from "react";
import { isApplePlatform } from "../../features/shortcuts/format";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Header } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { KEY_ONCE, SignIn } from "./auth";
import { SavedApiKey } from "../../features/settings/SavedApiKey";
import type { ClaudeSetup } from "./setup";

/** Credentials are independent of the installed Claude version, so a missing
 * or outdated runtime never prevents removing a saved key. */
export function ClaudeSettings({
  setup,
  active,
  clearKey,
}: {
  setup: ClaudeSetup;
  active(): boolean;
  clearKey(): Promise<void>;
}) {
  const [configured, setConfigured] = useState<boolean>();
  const [checking, setChecking] = useState(true);
  const [readError, setReadError] = useState("");
  const request = useRef(0);
  const [confirm, setConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState("");
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const section = useRef<HTMLElement>(null);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const setButton = useRef<HTMLButtonElement>(null);
  const connectForm = useRef<HTMLDivElement>(null);
  const storage = isApplePlatform(navigator.platform)
    ? "this Mac’s Keychain"
    : "this device’s secure storage";
  const check = useCallback(async () => {
    const current = ++request.current;
    setChecking(true);
    setReadError("");
    try {
      const account = await setup.auth.check();
      if (request.current === current) {
        setConfigured(account !== undefined);
        if (account !== undefined) setConnecting(false);
      }
    } catch (error) {
      if (request.current === current) {
        setReadError(String(error));
        setConnecting(false);
      }
    } finally {
      if (request.current === current) setChecking(false);
    }
  }, [setup]);
  useEffect(() => {
    const unsubscribe = setup.auth.subscribe(() => void check());
    void check();
    return () => {
      request.current++;
      unsubscribe();
    };
  }, [setup, check]);

  const clear = async () => {
    if (!active() || saving || clearing) return;
    setClearing(true);
    setClearError("");
    try {
      await clearKey();
      setConfigured(false);
      setConfirm(false);
      // A runtime refresh cannot undo the completed credential removal.
      await setup.check().catch(() => undefined);
    } catch (error) {
      setClearError(String(error));
    } finally {
      setClearing(false);
    }
  };
  const disabled = checking || saving || clearing || !!readError || !active();
  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-labelledby="claude-settings-title"
    >
      <Header
        id="claude-settings-title"
        title="Claude"
        subtitle={
          configured === true
            ? "Manage Claude’s credentials on this computer."
            : KEY_ONCE
        }
      />
      <div className="mt-section-gap grid gap-section-gap">
        <LoadingRegion
          pending={checking}
          label="Checking for a saved key…"
          statusVisibility="screen-reader"
          feedback={
            readError ? (
              <div className="flex flex-wrap items-center gap-3">
                <p role="alert" className="buzz-field-error m-0">
                  {readError}
                </p>
                <Button onClick={() => void check()}>Retry</Button>
              </div>
            ) : undefined
          }
        >
          {configured === true ? (
            <SettingsGroup layout="form">
              <SavedApiKey
                label="Anthropic API key"
                labelVisibility="visible"
                credential={setup.auth}
                onSaved={() => setup.check()}
                active={active}
                disabled={disabled}
                conceal={confirm || clearing || !!readError || !active()}
                onSavingChange={setSaving}
                trigger={actionsButton}
                onRemove={() => {
                  if (active()) {
                    setClearError("");
                    setConfirm(true);
                  }
                }}
              />
            </SettingsGroup>
          ) : (
            <SettingsGroup>
              <PreferenceRow
                title="Anthropic API key"
                subtitle={
                  configured === false && !readError
                    ? "No key saved."
                    : undefined
                }
                trailing={
                  <Button
                    ref={setButton}
                    size="sm"
                    disabled={disabled || configured === undefined}
                    onClick={() => {
                      if (active() && !disabled) setConnecting(true);
                    }}
                  >
                    Set
                  </Button>
                }
              />
            </SettingsGroup>
          )}
        </LoadingRegion>
      </div>
      {connecting && active() && (
        <Dialog
          open
          visit
          title="Connect Claude"
          description={KEY_ONCE}
          headerGap="compact"
          preventClose={saving}
          onOpenChange={(open) => !open && setConnecting(false)}
          initialFocus={() =>
            connectForm.current?.querySelector("input") ?? null
          }
          finalFocus={() =>
            actionsButton.current ?? setButton.current ?? section.current
          }
        >
          <div ref={connectForm}>
            <SignIn
              variant="dialog"
              setup={setup}
              disabled={disabled}
              active={active}
              onSavingChange={setSaving}
              onSaved={() => setConnecting(false)}
            />
          </div>
        </Dialog>
      )}
      {confirm && (
        <AlertDialog
          title="Remove Claude API key?"
          description={`This removes the key from ${storage}. New local Claude sessions will need a key. A turn already running can finish.`}
          pending={clearing}
          onClose={() => setConfirm(false)}
          finalFocus={() =>
            actionsButton.current ??
            setButton.current ??
            section.current?.querySelector<HTMLInputElement>("input") ??
            section.current
          }
          actions={
            <>
              <Button disabled={clearing} onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={clearing}
                onClick={() => void clear()}
              >
                Remove key
              </Button>
            </>
          }
        >
          {clearError && (
            <p role="alert" className="buzz-field-error m-0">
              {clearError}
            </p>
          )}
        </AlertDialog>
      )}
    </section>
  );
}
