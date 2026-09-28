import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { community, viewer, sign } from "./host.mjs";

const count = (h, path) => h.state.calls.filter((c) => c.path === path).length;
const profiles = (h) => h.state.publications.filter((e) => e.kind === 0);
const messages = (h) => h.state.publications.filter((e) => e.kind === 9);
const member = { admitted: true, profile: true };
export const scenarios = [];
const scenario = (id, options, run) => scenarios.push({ id, options, run });

scenario(
  "15-public-identity-restoration",
  member,
  async ({ page, host, mark, click, button, reload }) => {
    await click(button("Your profile"));
    await click(page.getByRole("menuitem", { name: "Settings", exact: true }));
    await click(button("Profile"));
    const publicKey = page.getByLabel("Public key (hex)", { exact: true });
    await publicKey.scrollIntoViewIfNeeded();
    await expect(publicKey).toHaveValue(viewer);
    await mark(
      "Settings shows the public key restored through fixture identity IPC",
    );
    await reload();
    await publicKey.scrollIntoViewIfNeeded();
    await expect(publicKey).toHaveValue(viewer);
    assert(
      host.state.calls.filter((c) => c.command === "identity_restore").length >=
        2,
    );
    assert(
      !host.state.calls.some((c) =>
        ["identity_create", "identity_import", "identity_export"].includes(
          c.command,
        ),
      ),
    );
    await mark(
      "Browser reload restores the same public identity without creating or exporting a key",
    );
  },
);

scenario(
  "01-member-messaging-restoration",
  member,
  async ({ page, host, mark, click, button, add, open, reload, send }) => {
    await add();
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Alex Morgan",
    );
    await mark("Existing member: keep the restored community profile");
    await open();
    assert.equal(count(host, "/api/invites/claim"), 0);
    assert.equal(profiles(host).length, 0);
    await mark("Signed history loaded through the native HTTP adapter");
    await send("The launch checklist looks good. Ready for Friday.");
    assert.equal(messages(host).length, 1);
    assert(host.state.signatures.includes(9));
    await mark("Write signed by the restored fixture identity");
    host.live("Thanks, Alex. I will share the final schedule this afternoon.");
    await expect(
      page.getByText(
        "Thanks, Alex. I will share the final schedule this afternoon.",
        { exact: true },
      ),
    ).toBeVisible();
    assert(host.state.signatures.includes(22242));
    await mark("Live reply on an authenticated fixture subscription");
    await reload();
    await expect(button("Switch to Harbour Studio")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(
      page.getByText("The launch checklist looks good. Ready for Friday.", {
        exact: true,
      }),
    ).toBeVisible();
    await mark(
      "Browser reload: same identity, selected community and conversation",
    );
    await click(button("Personal space"));
    await reload();
    await expect(button("Personal space")).toHaveAttribute(
      "aria-current",
      "true",
    );
    assert.notEqual(
      await page.evaluate(
        () => window.recordingServices.relay.snapshot().status,
      ),
      "ready",
    );
    await mark("Personal selection survives reload; no selected relay session");
  },
);

scenario(
  "02-invite-policy-profile",
  {},
  async ({ host, mark, click, button, add, invite, fill, published }) => {
    await add();
    await mark("Invitation admission requires policy and age confirmation");
    await invite();
    await click(button("Continue"));
    await fill("Display name", "Alex Morgan");
    await fill(
      "Profile description (optional)",
      "Product designer at Harbour Studio",
    );
    await mark("Complete the per-community profile");
    await published();
    assert.equal(count(host, "/api/invites/claim"), 1);
    assert.equal(profiles(host).length, 1);
    await mark(
      "Profile readback verified; membership saved and community opened",
    );
  },
);

scenario(
  "03-uncertain-send",
  member,
  async ({ page, host, mark, click, button, add, open, reload, send }) => {
    await page.clock.install();
    await add();
    await open();
    host.state.fault = "send";
    await send("Please reserve the studio for Friday at 10.");
    await page.clock.fastForward(11000);
    await expect(button("Retry")).toBeVisible();
    // The rendered update precedes the durable transaction commit.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const db = await new Promise((resolve, reject) => {
            const r = indexedDB.open("buzz-outbox-v2", 2);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          try {
            return await new Promise((resolve) => {
              const tx = db.transaction("events");
              const r = tx.objectStore("events").getAll();
              tx.oncomplete = () =>
                resolve(
                  r.result.some((e) => e.operation.delivery === "unknown"),
                );
            });
          } finally {
            db.close();
          }
        }),
      )
      .toBe(true);
    await mark("Receipt lost: message remains uncertain and retryable");
    await reload();
    await expect(button("Retry")).toBeVisible();
    assert.equal(messages(host).length, 1);
    await mark(
      "Reload restores uncertain delivery without automatically publishing again",
    );
    host.state.fault = "";
    await click(button("Retry"));
    await expect(button("Retry")).toHaveCount(0);
    assert.equal(messages(host).length, 2);
    assert.deepEqual(messages(host)[1], messages(host)[0]);
    assert.equal(host.state.signatures.filter((k) => k === 9).length, 1);
    await expect(
      page.getByText("Please reserve the studio for Friday at 10.", {
        exact: true,
      }),
    ).toHaveCount(1);
    await mark(
      "Explicit retry sends the identical signed event; one visible message",
    );
    await reload();
    await expect(
      page.getByText("Please reserve the studio for Friday at 10.", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(page.getByText(/Delivery not yet confirmed/)).toHaveCount(0);
    assert.equal(messages(host).length, 2);
    await mark("History readback shows one delivered message after reload");
  },
);

scenario(
  "04-interrupted-invite",
  {},
  async ({
    host,
    mark,
    click,
    button,
    add,
    invite,
    error,
    reload,
    fill,
    published,
    journal,
  }) => {
    await add();
    await invite();
    host.state.fault = "claim";
    await click(button("Continue"));
    await error("response was interrupted");
    await mark(
      "Invite admitted the identity; lost response retains setup intent",
    );
    assert(!JSON.stringify(await journal()).includes("v2.harbour-studio"));
    host.state.fault = "offline";
    await reload();
    await add(true);
    await error("offline");
    await mark("Recovery while offline keeps the pending join");
    host.state.fault = "";
    await click(button("Continue"));
    await fill("Display name", "Alex Morgan");
    await published();
    assert.equal(count(host, "/api/invites/claim"), 1);
    await mark(
      "Readback resumes profile setup without redeeming the invite again",
    );
  },
);

scenario(
  "05-profile-and-local-save",
  {},
  async ({
    page,
    host,
    mark,
    click,
    button,
    add,
    invite,
    fill,
    error,
    reload,
    open,
    journal,
  }) => {
    await add();
    await invite();
    await click(button("Continue"));
    await fill("Display name", "Alex Morgan");
    await fill(
      "Profile description (optional)",
      "Keeping the Friday launch on track",
    );
    host.state.fault = "profile";
    await click(button("Publish profile & open"));
    await error("response was interrupted");
    await mark(
      "Profile accepted remotely; interrupted response keeps the draft",
    );
    host.state.fault = "";
    await reload();
    await add(true);
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Alex Morgan",
    );
    await page.evaluate(() => {
      window.recordingSaveFault = "buzz-client.v1:";
    });
    await click(button("Open community"));
    await error("Could not save this community");
    assert.equal((await journal())[0].profile.name, "Alex Morgan");
    await mark(
      "Local membership save fails; dialog and recovery draft stay intact",
    );
    await reload();
    await add(true);
    await open();
    assert.equal(profiles(host).length, 1);
    assert.equal(count(host, "/api/invites/claim"), 1);
    assert.deepEqual(await journal(), []);
    await mark(
      "Storage restored: open succeeds without republishing profile or invite",
    );
  },
);

for (const fault of ["superseded", "missing", "read", "read-after"]) {
  const ids = {
    superseded: "06-superseded-profile",
    missing: "07-missing-profile",
    read: "08-read-before-publication",
    "read-after": "09-read-after-publication",
  };
  scenario(
    ids[fault],
    member,
    async ({
      page,
      host,
      mark,
      click,
      button,
      add,
      fill,
      error,
      reload,
      published,
      open,
      journal,
    }) => {
      if (fault === "superseded")
        host.state.profile = sign(
          0,
          [],
          JSON.stringify({
            name: "Alex Morgan",
            about: "Existing community profile",
            custom: "Keep this field",
          }),
          31,
          Math.floor(Date.now() / 1000) + 60,
        );
      await add();
      await fill("Display name", "Alex Morgan - Design");
      await fill(
        "Profile description (optional)",
        "Helping the team prepare for Friday",
      );
      host.state.fault = fault;
      await click(button("Publish profile & open"));
      await error(
        fault.startsWith("read")
          ? "Profile read unavailable"
          : "Your profile change is not current",
      );
      assert.equal((await journal())[0].profile.name, "Alex Morgan - Design");
      assert.equal(profiles(host).length, fault === "read" ? 0 : 1);
      await mark(
        `${fault}: completion blocked and the requested profile retained`,
      );
      host.state.fault = "";
      if (fault === "superseded")
        await page.clock.setFixedTime(Date.now() + 90000);
      await reload();
      await add(true);
      await expect(
        page.getByLabel("Display name", { exact: true }),
      ).toHaveValue("Alex Morgan - Design");
      await expect(
        page.getByLabel("Profile description (optional)"),
      ).toHaveValue("Helping the team prepare for Friday");
      await mark("Reload restores the exact requested name and description");
      if (fault === "read-after") await open();
      else await published();
      assert.equal(
        profiles(host).length,
        ["superseded", "missing"].includes(fault) ? 2 : 1,
      );
      if (fault !== "missing")
        assert.equal(
          JSON.parse(host.state.profile.content).custom,
          "Keep this field",
        );
      await mark(
        "Verified readback completes setup; extra profile fields preserved where present",
      );
    },
  );
}

scenario(
  "10-alias-changes",
  member,
  async ({
    page,
    host,
    mark,
    click,
    button,
    add,
    fill,
    error,
    reload,
    open,
    journal,
  }) => {
    await add();
    await fill("Display name", "Alex - First draft");
    host.state.fault = "profile";
    await click(button("Publish profile & open"));
    await error("response was interrupted");
    assert.equal((await journal())[0].community, community);
    host.state.aliases = { studio: community };
    await mark(
      "Pending join saved under canonical origin; add deployment alias studio",
    );
    await reload();
    await add(true);
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Alex - First draft",
    );
    await fill("Display name", "Alex - Latest draft");
    await click(button("Publish profile & open"));
    await error("response was interrupted");
    host.state.aliases = {};
    await mark(
      "Edit the recovered draft with alias configured; then remove alias",
    );
    host.state.fault = "";
    await reload();
    await add(true);
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Alex - Latest draft",
    );
    await open();
    assert.equal(profiles(host).length, 2);
    assert.deepEqual(await journal(), []);
    await mark("Same origin and latest draft recovered after alias removal");
  },
);

scenario(
  "11-journal-save-failure",
  {},
  async ({
    page,
    host,
    mark,
    click,
    button,
    add,
    invite,
    fill,
    error,
    published,
  }) => {
    await add();
    await invite();
    await page.evaluate(() => {
      window.recordingSaveFault = "buzz-community-joins.v1:";
    });
    await click(button("Continue"));
    await error("Could not save community setup");
    assert.equal(count(host, "/api/invites/claim"), 0);
    assert.equal(count(host, "/api/invites/accept-policy"), 0);
    await mark(
      "Journal cannot save: no policy acceptance or invite claim dispatched",
    );
    await page.evaluate(() => {
      window.recordingSaveFault = "";
    });
    await click(button("Continue"));
    await fill("Display name", "Alex Morgan");
    await published();
    await mark("Storage restored: explicit retry completes admission");
  },
);

scenario(
  "12-expired-send-readback",
  member,
  async ({ page, host, mark, click, button, add, open, send, reload }) => {
    await page.clock.install();
    await add();
    await open();
    host.state.fault = "send";
    await send("The revised launch notes are ready.");
    await page.clock.fastForward(11000);
    await expect(button("Retry")).toBeVisible();
    const original = messages(host)[0];
    await page.clock.setFixedTime(Date.now() + 16 * 60000);
    host.state.fault = "offline";
    await click(button("Retry"));
    await expect(page.getByText(/Community is offline/)).toBeVisible();
    await mark(
      "Clock advanced 16 minutes: failed readback retains uncertainty",
    );
    host.state.fault = "";
    await click(button("Retry"));
    await expect(
      page.getByText(/This event is too old to retry/),
    ).toBeVisible();
    await mark(
      "Missing ID: keep delivery uncertain; do not re-date or republish",
    );
    host.state.records.push(original);
    await click(button("Retry"));
    await expect(button("Retry")).toHaveCount(0);
    assert.equal(messages(host).length, 1);
    assert.equal(host.state.signatures.filter((k) => k === 9).length, 1);
    await mark(
      "Strong ID readback finds the original event without another write",
    );
    await reload();
    await expect(
      page.getByText("The revised launch notes are ready.", { exact: true }),
    ).toHaveCount(1);
    await expect(page.getByText(/Delivery not yet confirmed/)).toHaveCount(0);
    assert.equal(messages(host).length, 1);
    await mark(
      "Reload displays the original message from history with no pending notice",
    );
  },
);

scenario(
  "13-interrupted-verification",
  member,
  async ({
    page,
    host,
    mark,
    click,
    button,
    add,
    fill,
    reload,
    open,
    journal,
  }) => {
    await add();
    await fill("Display name", "Alex Morgan - Design");
    let release;
    host.state.verificationGate = new Promise((done) => {
      release = done;
    });
    try {
      await click(button("Publish profile & open"));
      await expect.poll(() => host.state.verificationStarted).toBe(true);
      await expect(button("Working…")).toBeDisabled();
      assert.equal((await journal())[0].profile.name, "Alex Morgan - Design");
      await mark(
        "Publication acknowledged; completion waits for profile readback",
      );
      await reload();
      release();
      await add(true);
      await expect(
        page.getByLabel("Display name", { exact: true }),
      ).toHaveValue("Alex Morgan - Design");
      await mark(
        "Reload interrupts verification; retained draft recovers from current profile",
      );
      await open();
      assert.equal(profiles(host).length, 1);
      assert.deepEqual(await journal(), []);
      await mark(
        "Explicit open completes once; late old response does not discard recovery",
      );
    } finally {
      release();
    }
  },
);

scenario(
  "14-legacy-alias-overlap",
  member,
  async ({
    page,
    host,
    mark,
    click,
    button,
    add,
    error,
    reload,
    open,
    journal,
  }) => {
    // Seed old on-disk data to exercise an upgrade; no application state is faked.
    await page.evaluate(
      ({ viewer, community }) => {
        localStorage.setItem(
          `buzz-community-joins.v1:${viewer}`,
          JSON.stringify([
            {
              id: "legacy-studio",
              community: "studio",
              profile: { name: "Alex - Older draft", picture: "" },
            },
            {
              id: "legacy-archive",
              community: "archive",
              profile: { name: "Unrelated saved draft", picture: "" },
            },
            {
              id: "origin-latest",
              community,
              profile: { name: "Alex - Latest draft", picture: "" },
            },
          ]),
        );
      },
      { viewer, community },
    );
    await add(true);
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Alex - Latest draft",
    );
    host.state.fault = "profile";
    await click(button("Publish profile & open"));
    await error("response was interrupted");
    assert((await journal()).some((e) => e.community === "archive"));
    await mark(
      "Seeded legacy aliases lack mappings; usable origin recovery still works",
    );
    host.state.aliases = { studio: community };
    host.state.fault = "";
    await reload();
    await add(true);
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Alex - Latest draft",
    );
    await mark("Restore studio mapping: newest overlapping draft wins");
    await open();
    const retained = await journal();
    assert.equal(retained.length, 1);
    assert.equal(retained[0].community, "archive");
    assert.equal(profiles(host).length, 1);
    await mark(
      "Join completes; unrelated unresolved archive draft is retained",
    );
  },
);
