import { selectSettingsSection } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

// Browser boundary: enabling the opt-in Mesh plugin must expose its consumer view in Settings → Compute.
for (const personal of [false, true]) {
  test(`enabling Mesh compute opens Settings Compute (personal=${personal})`, async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    const button = (name) => page.getByRole("button", { name, exact: true });
    if (personal) await button("Personal space").click();
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
    const compute = page
      .getByRole("complementary", { name: "Settings sidebar", exact: true })
      .getByRole("button", { name: "Compute", exact: true });
    await expect(compute.locator("xpath=ancestor::section[1]")).toContainText(
      personal ? "App" : "Primary",
    );
    await expect(
      page
        .getByRole("complementary", { name: "Settings sidebar", exact: true })
        .getByText("Compute", { exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Use shared compute", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Compute consumer", exact: true })
        .getByRole("status"),
    ).toHaveText(
      personal
        ? "Select a community to use shared compute."
        : "Open Buzz desktop to use shared compute.",
    );
    await expect(button("Connect to community compute")).toBeDisabled();
    await expect(page.getByText("This destination couldn’t open")).toHaveCount(
      0,
    );
  });
}
