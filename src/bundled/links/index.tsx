import type { Context } from "@deepseek-ai/cordis";
import type { PluginModule } from "../../plugins/api";
import { LinkLabel, linkKind } from "./InlineLink";
import styles from "../../shared/InlineReference.module.css";
import { Login } from "../../shared/oauth/Login";
import { browserLoginAvailable } from "../../shared/oauth/native-bridge";
import { createOAuthSession } from "../../shared/oauth/session";
import { createDriveTitles, driveFileId } from "./google/drive";
import { DriveLinkLabel } from "./google/DriveLinkLabel";
import {
  googleClient,
  googleCredential,
  type GoogleCredential,
} from "./google/oauth";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const titles = googleDrive(ctx);
  ctx.conversation.registerLink({
    id: "links",
    title: "Links",
    matches: (url) => linkKind(url) !== null,
    className: styles.link,
    component: ({ url }) =>
      titles && driveFileId(url) ? (
        <DriveLinkLabel titles={titles} url={url} />
      ) : (
        <LinkLabel href={url} />
      ),
  });
};

/** Drive names need the desktop host transport and Settings; hosts without them keep plain labels. */
function googleDrive(ctx: Context) {
  const host = ctx.get("host");
  const cards = ctx.get("settingsCards");
  if (!host || !cards) return undefined;
  let unavailable = "";
  try {
    googleClient();
  } catch (error) {
    unavailable =
      error instanceof Error ? error.message : "Google sign-in is unavailable.";
  }
  const session = createOAuthSession<GoogleCredential>("Google", (signal) =>
    googleCredential(host, signal),
  );
  const titles = createDriveTitles(host, session);
  ctx.effect(() => () => {
    titles.dispose();
    session.dispose();
  });
  cards.register({
    id: "google",
    title: "Google",
    group: "Integrations",
    component: ({ active }) => (
      <Login
        provider="Google"
        description="Show the names of Google Docs, Sheets, Slides and Drive links you can open. Your Google access stays in memory until you sign out or close Buzz."
        session={session}
        available={browserLoginAvailable() && !unavailable}
        unavailableReason={
          browserLoginAvailable()
            ? unavailable
            : "Open the Buzz desktop app to sign in with Google."
        }
        active={active}
      />
    ),
  });
  return titles;
}
