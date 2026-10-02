import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertDialog } from "../../src/shared/design-system/ui/AlertDialog";
import { Button } from "../../src/shared/design-system/ui/Button";
import { AvatarEditor } from "../../src/features/profiles/AvatarEditor";
import { EnterpriseLoginRequired } from "../../src/features/communities/service";
import "../../src/shared/styles/globals.css";

const community = "https://enterprise.example";

function Fixture() {
  const [picture, setPicture] = useState("https://images.example/original.png");
  const [prompt, setPrompt] = useState(false);
  const connect = async () => {
    setPrompt(true);
    throw new EnterpriseLoginRequired(community);
  };
  return (
    <main className="p-8">
      <h1>Enterprise avatar fixture</h1>
      <p>Local synthetic gate; no native identity or network access.</p>
      <AvatarEditor
        value={picture}
        name="Fixture human"
        community={community}
        connect={connect}
        onChange={setPicture}
      />
      <output aria-label="Saved picture">{picture}</output>
      {prompt && (
        <AlertDialog
          title="Sign in to this community"
          description="This trusted community requires enterprise sign-in before Buzz can connect."
          onClose={() => setPrompt(false)}
          actions={
            <>
              <Button type="button" onClick={() => setPrompt(false)}>
                Not now
              </Button>
              <Button type="button" variant="prominent">
                Sign in
              </Button>
            </>
          }
        >
          <p>Buzz will return here after the browser sign-in is complete.</p>
        </AlertDialog>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
