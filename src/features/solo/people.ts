/** Whether a Solo chat has another person in it. Alone, the viewer addresses
 * agents and must tag one; once shared, people can talk without a tag. */
export function soloHasPeople(
  members: readonly string[] | undefined,
  viewer: string | undefined,
  agents: ReadonlySet<string>,
): boolean {
  return !!members?.some((key) => key !== viewer && !agents.has(key));
}
