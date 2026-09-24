import { useRef, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { DotsThreeIcon } from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { avatarSource } from "../../shared/avatar-source";
import type { AgentLibrary } from "../../features/agents/library";
import type { AgentView } from "../../features/agents/control";
import type { RelaySession } from "../../features/relay/session";

export function InventoryCard({
  name,
  avatar,
  identities,
  session,
  media,
  editable = [],
  onEdit,
  children,
  identityLabel = (identity) => identity.name,
  layout = "tile",
  headingLevel = 3,
}: {
  children?: ReactNode;
  identityLabel?: (identity: { pubkey: string; name: string }) => string;
  layout?: "tile" | "row";
  headingLevel?: 3 | 4;
  name: string;
  avatar?: string | undefined;
  identities: AgentLibrary["identities"];
  session?: RelaySession;
  media?: RelaySession["media"] | undefined;
  editable?: AgentView[];
  onEdit?: ((agent: AgentView, avatar?: string) => void) | undefined;
}) {
  const Heading = headingLevel === 4 ? "h4" : "h3";
  const trigger = useRef<HTMLButtonElement>(null);
  const source = avatarSource(avatar);
  const picture = source?.startsWith("data:")
    ? source
    : source
      ? (media ?? session?.media)?.(source, "small")
      : undefined;
  return (
    <article
      aria-label={`Agent ${name}`}
      className={`relative min-w-0 ${layout === "row" ? "agent-inventory-row" : "flex flex-col gap-3 rounded-2xl border border-primary p-4"}`}
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
                  icon={<DotsThreeIcon size={18} aria-hidden="true" />}
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
                            Edit {identityLabel(agent)}
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
      <div
        className={
          children
            ? `flex min-w-0 items-center gap-3 ${onEdit ? "pr-6" : ""}`
            : "flex flex-1 flex-col gap-4"
        }
      >
        <div
          className={
            children
              ? "shrink-0"
              : "flex min-h-36 items-center justify-center py-5"
          }
        >
          <Avatar
            alt={name}
            fallback={name}
            src={picture ?? null}
            size={layout === "row" ? "default" : "large"}
            shape="squircle"
          />
        </div>
        <Heading className="m-0 min-w-0 truncate text-label" title={name}>
          {name}
        </Heading>
      </div>
      {children && (
        <div
          className={
            layout === "row"
              ? `flex min-w-0 flex-wrap items-center gap-2 ${onEdit ? "pr-8" : ""}`
              : "flex min-w-0 flex-col gap-3"
          }
        >
          {children}
        </div>
      )}
      {identities.length && !children ? (
        <Accordion
          items={[
            {
              value: "key",
              title: "Public key",
              content: (
                <>
                  {identities.map((identity) => (
                    <p
                      key={identity.pubkey}
                      className="m-0 mt-1 select-all break-all text-mono-sm"
                    >
                      {identity.pubkey}
                    </p>
                  ))}
                </>
              ),
            },
          ]}
        />
      ) : !children ? (
        <p className="m-0 mt-1 text-body-sm text-secondary">
          No linked identity
        </p>
      ) : null}
    </article>
  );
}
