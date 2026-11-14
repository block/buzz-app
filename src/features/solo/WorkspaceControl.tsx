import { useSoloNavigation } from "../channel-navigation/solo-navigation-react";
import { prepareSoloMove } from "../channel-navigation/solo-navigation";
import { useEffect, useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import {
  CaretDownIcon,
  Cube3dSphereIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { NewWorkspace } from "./NewWorkspace";
import styles from "./WorkspaceControl.module.css";
import { useRegionWorkspace } from "./chat-workspace";

export function WorkspaceControl({
  session,
  value,
  onChange,
  channelId,
  disabled = false,
}: {
  session: RelaySession;
  value?: string | undefined;
  onChange?: ((projectId: string) => void) | undefined;
  channelId?: string | undefined;
  disabled?: boolean;
}) {
  const regions = useSoloNavigation(session);
  // A region's chat is filed by its region, when the region offers that.
  const filed = useRegionWorkspace(session, channelId);
  const [snapshot, setSnapshot] = useState(() =>
    session.soloPreferences.snapshot(),
  );
  useEffect(() => {
    const subscribe = session.soloPreferences.subscribe;
    if (typeof subscribe !== "function") return;
    return subscribe(() => setSnapshot(session.soloPreferences.snapshot()));
  }, [session]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const projectId =
    value ??
    (filed
      ? filed.id
      : channelId
        ? snapshot.data?.assignments[channelId]
        : undefined) ??
    "";
  const project = snapshot.data?.sections.find((item) => item.id === projectId);
  const choose = (next: string) => {
    setError("");
    if (onChange) {
      onChange(next);
      return;
    }
    if (!channelId) return;
    const blocked = filed ? undefined : prepareSoloMove(session, channelId);
    if (blocked) {
      setError(blocked);
      return;
    }
    setBusy(true);
    void (
      filed
        ? filed.file(next || undefined)
        : session.soloPreferences.assign(channelId, next || undefined)
    )
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(false));
  };
  const name = project ? `Workspace: ${project.name}` : "Add workspace";
  // Disabled only for a moment: while workspaces load (as they do after New
  // workspace), a chat moves, or New chat starts its chat. Focus handed back
  // to the control then must stay, so it stays focusable.
  const inactive =
    disabled ||
    busy ||
    snapshot.status === "idle" ||
    snapshot.status === "loading";
  if (channelId && regions.managed.has(channelId) && !filed) return null;
  return (
    <span className={styles.control}>
      {/* Saving keeps the trigger focusable, so the choice returns focus to it. */}
      <MenuRoot
        onOpenChange={(open, details) => {
          if (open && busy) details.cancel();
        }}
      >
        <MenuTrigger
          ref={trigger}
          disabled={inactive}
          render={(props) => (
            <Button
              {...props}
              focusableWhenDisabled={inactive}
              variant="ghost"
              size="sm"
              shape={project ? "capsule" : "icon"}
              style={{ maxWidth: "100%" }}
              aria-label={name}
              title={name}
            >
              <Cube3dSphereIcon size={16} aria-hidden="true" />
              {project && (
                <>
                  <span className={styles.name}>{project.name}</span>
                  <CaretDownIcon
                    size={12}
                    className="buzz-dropdown-chevron"
                    aria-hidden="true"
                  />
                </>
              )}
            </Button>
          )}
        />
        <MenuPopup side="top" align="end" aria-label="Choose workspace">
          <MenuRadioGroup value={projectId} onValueChange={choose}>
            <MenuRadioItem value="" closeOnClick>
              No workspace
            </MenuRadioItem>
            {(snapshot.data?.sections ?? []).map((item) => (
              <MenuRadioItem key={item.id} value={item.id} closeOnClick>
                {item.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          {snapshot.status === "error" && (
            <MenuItem onClick={() => void session.soloPreferences.refresh()}>
              Retry workspaces
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            disabled={!session.soloPreferences.sectionCreationWritable}
            onClick={() => setCreating(true)}
          >
            New workspace
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      {error && <span role="alert">{error}</span>}
      {creating && (
        <NewWorkspace
          session={session}
          create={async (section) => {
            const store = session.soloPreferences;
            if (onChange || !channelId) return store.createSection(section);
            if (filed) {
              // A region files its own chat, so the workspace is created on
              // its own. When only the filing failed, Retry files again and
              // leaves the workspace it finds alone.
              const exists = store
                .snapshot()
                .data?.sections.some((item) => item.id === section.id);
              if (!exists) await store.createSection(section);
              return filed.file(section.id);
            }
            const blocked = prepareSoloMove(session, channelId);
            if (blocked) return Promise.reject(new Error(blocked));
            // The groups record can't be saved twice within a second, so a
            // saved chat moves in the write that creates its workspace.
            return store
              .createAndAssign(channelId, section)
              .catch((reason: unknown) => {
                // The dialog reports the failure and retries it with its
                // folders and instructions. The sidebar's Retry move would
                // replay only the move, so drop the store's record of it.
                store.dismissMoveError(channelId);
                throw reason;
              });
          }}
          close={() => setCreating(false)}
          finalFocus={trigger}
          // A saved chat moved as Create wrote, so an earlier move's error
          // no longer applies.
          onCreated={(id) => (onChange ? choose(id) : setError(""))}
        />
      )}
    </span>
  );
}
