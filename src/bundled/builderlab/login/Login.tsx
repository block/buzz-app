import { Login as OAuthLogin } from "../../../shared/oauth/Login";
import type { OAuthSession } from "../oauth/session";

export function Login(props: {
  session: OAuthSession;
  available: boolean;
  active(): boolean;
  showHeading?: boolean;
  unavailableReason?: string;
}) {
  return (
    <OAuthLogin
      provider="Builderlab"
      description="Connect your Builderlab account. Your credential stays in memory until you sign out or close Buzz."
      {...props}
    />
  );
}
