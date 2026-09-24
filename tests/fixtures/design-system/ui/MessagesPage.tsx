import { useColorScheme } from "../../../../src/shared/design-system/theme/useColorScheme";

export function MessagesPage() {
  const { scheme } = useColorScheme();
  const source = `./message-gallery.html?theme=${scheme}`;
  return (
    <section className="messages-page">
      <header className="component-page-heading">
        <h1 className="text-title text-primary">Messages</h1>
        <p className="text-body text-tertiary">
          Current message layouts and states, rendered by the app’s components
          with sample data.
        </p>
      </header>
      <iframe title="Message types and states" src={source} />
    </section>
  );
}
