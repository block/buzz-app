import type { ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";

/** Names a Settings section within a sentence. With `open`, it is a link to
 * that section; without one, the sentence still reads as plain text. */
export function SettingsSectionLink({
  section,
  open,
  children,
}: {
  section: string;
  open?: ((section: string) => void) | undefined;
  children: ReactNode;
}) {
  return open ? (
    <Button variant="link" size="inline" onClick={() => open(section)}>
      {children}
    </Button>
  ) : (
    children
  );
}
