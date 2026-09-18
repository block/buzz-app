import { IconUsers } from "@tabler/icons-react";
import { Button } from "../../shared/design-system/ui/Button";
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
  const source = avatarSource(avatar);
  const picture = source?.startsWith("data:")
    ? source
    : source
      ? session?.media(source, "small")
      : undefined;
  return (
    <article
      aria-label={`Agent ${name}`}
      className="flex min-w-0 flex-col rounded-2xl border border-primary p-4"
    >
      <div className="flex min-h-36 flex-1 items-center justify-center py-5">
        <Avatar alt={name} fallback={name} src={picture ?? null} size="large" />
      </div>
      <h3 className="m-0 truncate text-label" title={name}>
        {name}
      </h3>
      {onEdit && (
        <div className="my-3">
          {editable.length < 2 ? (
            <Button
              disabled={!editable.length}
              onClick={() => {
                if (editable[0]) onEdit(editable[0], picture);
              }}
            >
              Edit
            </Button>
          ) : (
            <details className="space-y-2">
              <summary className="cursor-pointer text-body-sm">
                Edit identity…
              </summary>
              {editable.map((agent) => (
                <Button key={agent.id} onClick={() => onEdit(agent, picture)}>
                  <span className="min-w-0 break-all">
                    {agent.name}
                    <br />
                    {agent.relayUrl}
                    <br />
                    <span className="text-mono-sm">{agent.pubkey}</span>
                  </span>
                </Button>
              ))}
            </details>
          )}
          {!editable.length && !!identities.length && (
            <p className="mt-2 text-body-sm text-secondary">
              Import this identity to edit in Foundation.
            </p>
          )}
        </div>
      )}
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
