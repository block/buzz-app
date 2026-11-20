import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  historyCounts: { alpha: 0, beta: 0 },
  pluginFixtures: true,
  enabledPlugins: ["buzz.drafts-and-sent"],
});

// Exercises real composer persistence, sidebar navigation and conversation preview wiring.
test("unfinished messages appear in Drafts and resume after navigation and reload", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const editor = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await editor.fill("Work in progress—finish this later");
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  const drafts = pages.getByRole("button", { name: /^Drafts & sent/ });
  await expect(
    drafts.getByRole("img", { name: "1 draft", exact: true }),
  ).toBeVisible();
  await drafts.click();
  const region = page.getByRole("region", {
    name: "Drafts & sent",
    exact: true,
  });
  await expect(region.getByRole("tab", { name: /Drafts/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await region
    .getByRole("button", { name: /Continue draft.*Work in progress/ })
    .click();
  await expect(editor).toHaveText("Work in progress—finish this later");
  await editor.fill("Work in progress—continued from Drafts");
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (mode) => (document.documentElement.dataset.colorMode = mode),
      mode,
    );
    await page.screenshot({
      path: testInfo.outputPath(`draft-in-progress-${mode}.png`),
      animations: "disabled",
    });
  }
  await page.reload();
  await expect(drafts).toBeVisible();
  await drafts.click();
  await region
    .getByRole("button", { name: /Continue draft.*continued from Drafts/ })
    .click();
  await expect(editor).toHaveText("Work in progress—continued from Drafts");
});
