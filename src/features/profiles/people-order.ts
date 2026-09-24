type Person = { name: string; pubkey: string };

/** Shared by recipient and mention pickers; eligibility stays with each caller. */
export function peopleOrder(query: string) {
  const needle = query.trim().toLowerCase();
  return (a: Person, b: Person) =>
    Number(!a.name.toLowerCase().startsWith(needle)) -
      Number(!b.name.toLowerCase().startsWith(needle)) ||
    a.name.localeCompare(b.name) ||
    a.pubkey.localeCompare(b.pubkey);
}
