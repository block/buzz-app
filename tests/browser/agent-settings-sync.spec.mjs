import { test, expect } from "./source-fixture.mjs";

// Real grid + settings host wiring, focus, responsive conflict controls and a
// reload of fixture storage. The reconciliation matrix belongs in Vitest.
test("Claude grid changes reconcile with the open settings draft", async ({
  page,
}, info) => {
  await page.goto("/tests/fixtures/agent-library.html?settingsSync");
  await page.getByText("Ada", { exact: true }).click();
  const pane = page.getByRole("tabpanel", { name: "Identity", exact: true });
  const sidebarModel = pane.getByRole("combobox", {
    name: "Model",
    exact: true,
  });
  await expect(sidebarModel).toBeVisible();
  const gridModel = page
    .getByRole("gridcell", { name: "Ada", exact: true })
    .getByRole("combobox", { name: "Model", exact: true });
  await gridModel.click();
  await page
    .getByRole("option", { name: "Other Claude model", exact: true })
    .click();
  await expect(sidebarModel).toContainText("Other Claude model");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);

  await pane
    .getByLabel("Instructions", { exact: true })
    .fill("Keep these instructions.");
  await gridModel.click();
  await page
    .getByRole("option", {
      name: "Fictional Claude model · Default",
      exact: true,
    })
    .click();
  await expect(sidebarModel).toContainText("Fictional Claude model");
  await expect(pane.getByLabel("Instructions", { exact: true })).toHaveValue(
    "Keep these instructions.",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByText("Ada", { exact: true }).click();
  await expect(pane.getByLabel("Instructions", { exact: true })).toHaveValue(
    "Keep these instructions.",
  );
  await expect(sidebarModel).toContainText("Fictional Claude model");

  // Competing model edits must remain a deliberate choice, including at narrow
  // widths and enlarged text where the host moves the pane over the grid.
  await sidebarModel.click();
  await page.getByRole("option", { name: "Custom model", exact: true }).click();
  await page.getByRole("textbox", { name: "Model ID" }).fill("my-model");
  await page.getByRole("button", { name: "Use model", exact: true }).click();
  await gridModel.click();
  await page
    .getByRole("option", { name: "Other Claude model", exact: true })
    .click();
  await expect(pane.getByRole("alert")).toContainText(
    "Model and thinking changed elsewhere",
  );
  for (const { width, dark, fontSize } of [
    { width: 1280, dark: false, fontSize: "16px" },
    { width: 390, dark: true, fontSize: "20px" },
  ]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(
      ({ dark, fontSize }) => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.fontSize = fontSize;
      },
      { dark, fontSize },
    );
    const resolve = pane.getByRole("button", {
      name: "Use saved model and thinking",
    });
    await resolve.scrollIntoViewIfNeeded();
    await expect(resolve).toBeVisible();
    await resolve.focus();
    await expect(resolve).toBeFocused();
    await page.screenshot({ path: info.outputPath(`conflict-${width}.png`) });
  }
  await page.keyboard.press("Enter");
  await expect(pane.getByRole("alert")).toHaveCount(0);
  await expect(sidebarModel).toContainText("Other Claude model");
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
});
