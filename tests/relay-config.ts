// Synthetic deployment configuration; never import a developer's .env into fixtures.
export const fixtureRelayUrl = "https://primary.example";
export const fixtureAliases = JSON.stringify({
  primary: fixtureRelayUrl,
  secondary: "https://secondary.example",
});
