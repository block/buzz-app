import { useRef } from "react";
import { Menu } from "@base-ui/react/menu";
import { IconDots, IconUsers } from "@tabler/icons-react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { avatarSource } from "../../shared/avatar-source";
import type { AgentLibrary } from "../../features/agents/library";
import type { AgentView } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";

export function AgentCard({
  name,
  avatar,
  identities,
  session,
  editable = [],
  onEdit,
}: {
  name: string;
  avatar?: string | undefined;
  identities: AgentLibrary["identities"];
  session?: RelaySession;
  editable?: AgentView[];
  onEdit?: ((agent: AgentView, avatar?: string) => void) | undefined;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const source = avatarSource(avatar);
  const picture = source?.startsWith("data:")
    ? source
    : source
      ? session?.media(source, "small")
      : undefined;
  return (
    <article
      aria-label={`Agent ${name}`}
      className="relative flex min-w-0 flex-col rounded-2xl border border-primary p-4"
    >
      {onEdit && (
        <div className="absolute right-2 top-2">
          <Menu.Root>
            <Menu.Trigger
              ref={trigger}
              render={
                <IconButton
                  aria-label={`Actions for ${name}`}
                  size="compact"
                  icon={<IconDots size={18} stroke={2} aria-hidden="true" />}
                />
              }
            />
            <Menu.Portal>
              <Menu.Positioner align="end" sideOffset={4}>
                <Menu.Popup
                  data-buzz-ui=""
                  className="min-w-36 max-w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-primary bg-float p-1 text-body text-primary shadow-lg"
                >
                  {editable.length ? (
                    editable.map((agent) => (
                      <Menu.Item
                        key={agent.id}
                        className="cursor-pointer rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-hover"
                        onClick={() => {
                          // The menu item unmounts; return from the dialog to the card.
                          trigger.current?.focus();
                          onEdit(agent, picture);
                        }}
                      >
                        {editable.length === 1 ? (
                          "Edit"
                        ) : (
                          <>
                            Edit {agent.name}
                            <span className="block break-all text-body-sm text-secondary">
                              {agent.relayUrl}
                            </span>
                            <span className="block break-all text-mono-sm text-secondary">
                              {agent.pubkey}
                            </span>
                          </>
                        )}
                      </Menu.Item>
                    ))
                  ) : (
                    <>
                      <Menu.Item
                        disabled
                        className="rounded-lg px-3 py-2 text-disabled"
                      >
                        Edit
                      </Menu.Item>
                      <p className="m-0 max-w-64 px-3 py-2 text-body-sm text-secondary">
                        {identities.length
                          ? "Import this identity to edit in Foundation."
                          : "No linked identity to edit."}
                      </p>
                    </>
                  )}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </div>
      )}
      <div className="flex min-h-36 flex-1 items-center justify-center py-5">
        <Avatar
          alt={name}
          fallback={name}
          src={picture ?? null}
          size="large"
          shape="squircle"
        />
      </div>
      <h3 className="m-0 truncate text-label" title={name}>
        {name}
      </h3>
      {identities.length ? (
        <Accordion
          items={[
            {
              value: "identities",
              title: (
                <span className="flex items-center gap-2">
                  <IconUsers size={16} stroke={2} aria-hidden="true" />
                  <span className="sr-only">{name}: </span>
                  {identities.length}{" "}
                  {identities.length === 1 ? "identity" : "identities"}
                </span>
              ),
              content: (
                <ul className="mt-2 space-y-3 border-t border-primary pt-3">
                  {identities.map((identity) => (
                    <li key={identity.pubkey}>
                      <span className="font-semibold text-primary">
                        {identity.name}
                      </span>
                      <p className="m-0 mt-1 select-all break-all text-mono-sm">
                        {identity.pubkey}
                      </p>
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      ) : (
        <p className="m-0 mt-1 text-body-sm text-secondary">
          No linked identity
        </p>
      )}
    </article>
  );
}
