import { selectSettingsSection } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

// Browser boundary: enabling the opt-in Mesh plugin must expose its consumer view in Settings → Compute.
test("enabling Mesh compute opens Settings Compute", async ({ page, app }) => {
  await page.goto(app.origin);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await selectSettingsSection(page, "Plugins");
  const enabled = page.getByRole("switch", {
    name: "Enable Mesh compute",
    exact: true,
  });
  await enabled.click();
  await expect(enabled).toBeChecked();
  // Contributed cards own their region label rather than the built-in section wrapper.
  await page
    .getByRole("complementary", { name: "Settings sidebar", exact: true })
    .getByRole("button", { name: "Compute", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Use shared compute", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Compute consumer", exact: true })
      .getByRole("status"),
  ).toHaveText("Open Buzz desktop to use shared compute.");
  await expect(button("Connect to community compute")).toBeDisabled();
  await expect(page.getByText("This destination couldn’t open")).toHaveCount(0);
});
