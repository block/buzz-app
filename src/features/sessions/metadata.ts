/** Ordinary channel metadata describes presentation, never access authority. */
export const SESSION_CHANNEL_DESCRIPTION = "Buzz session (buzz.sessions/v1)";
/** Marks a personal chat: its owner plus their agents, answered as one
 * channel-scoped conversation at top level. Remote agents read it from
 * channel metadata because Me placement is private to the owner. Explicit conversion to
 * a channel replaces the description, which clears it. */
const PERSONAL_LINE = "personal";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SessionNaming = Readonly<{
  /** Absent for historical sessions whose original automatic title is unknown. */
  automatic?: string;
  explicit: boolean;
}>;

export function sessionDescription(
  parentId?: string,
  options?:
    | SessionNaming
    | { personal?: boolean; naming?: SessionNaming | undefined }
    | boolean,
): string {
  let personal = false;
  let naming: SessionNaming | undefined;
  if (typeof options === "boolean") personal = options;
  else if (options && "explicit" in options) naming = options;
  else if (options) {
    personal = !!options.personal;
    naming = options.naming;
  }
  return [
    SESSION_CHANNEL_DESCRIPTION,
    ...(parentId ? [`parent:${parentId}`] : []),
    ...(personal ? [PERSONAL_LINE] : []),
    ...(naming ? [`naming:${JSON.stringify(naming)}`] : []),
  ].join("\n");
}
export function sessionMetadata(description: string | undefined):
  | {
      parentId?: string;
      personal?: true;
      naming?: SessionNaming;
    }
  | undefined {
  if (!description) return;
  const [marker, ...lines] = description.split("\n");
  if (marker !== SESSION_CHANNEL_DESCRIPTION) return;
  const parent = lines[0]?.startsWith("parent:")
    ? lines.shift()?.slice("parent:".length)
    : undefined;
  if (parent !== undefined && !uuid.test(parent)) return;
  const personal = lines[0] === PERSONAL_LINE && !!lines.shift();
  let naming: SessionNaming | undefined;
  if (lines.length) {
    if (lines.length !== 1 || !lines[0]?.startsWith("naming:")) return;
    try {
      const value: unknown = JSON.parse(lines[0].slice(7));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("explicit" in value) ||
        typeof value.explicit !== "boolean" ||
        Object.keys(value).some(
          (key) => !["explicit", "automatic"].includes(key),
        )
      )
        return;
      const automatic = "automatic" in value ? value.automatic : undefined;
      if (
        automatic !== undefined &&
        (typeof automatic !== "string" ||
          !automatic ||
          [...automatic].length > 80 ||
          /^[#\p{White_Space}]|\p{White_Space}$/u.test(automatic))
      )
        return;
      if (!value.explicit && automatic === undefined) return;
      naming = {
        ...(typeof automatic === "string" ? { automatic } : {}),
        explicit: value.explicit,
      };
      // One canonical encoding across the browser/native allowlists and readback.
      if (sessionDescription(parent, { personal, naming }) !== description)
        return;
    } catch {
      return;
    }
  }
  return {
    ...(parent ? { parentId: parent } : {}),
    ...(personal ? { personal: true as const } : {}),
    ...(naming ? { naming } : {}),
  };
}
