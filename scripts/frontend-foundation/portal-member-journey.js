// Run after scripts/plan21/browser-acceptance-fixture.js in the same session.
async function reviewMemberActions(page) {
  const origin = new URL(page.url()).origin;
  const artifacts = "output/playwright/ui-purchasing-review";
  await page
    .context()
    .addCookies([
      {
        name: "satyr_control_csrf",
        value: "isolated-member-review",
        url: origin,
      },
    ]);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${origin}/portal/cafe-browser-lab/main/settings`);
  const owner = page
    .locator(".account-row")
    .filter({ hasText: "aiko@example.test" });
  await owner
    .getByText("Keep at least one owner in this workspace.", { exact: true })
    .waitFor();
  if (
    !(await owner.getByRole("combobox").isDisabled()) ||
    !(await owner
      .getByRole("button", { name: "Remove member", exact: true })
      .isDisabled())
  )
    throw new Error("The last owner can be removed or demoted.");
  const member = page
    .locator(".account-row")
    .filter({ hasText: "camille.boulangerie.saint-honore@example.test" });
  const changed = page.waitForRequest("**/members/user_operator");
  await chooseOption(page, member.getByRole("combobox"), { value: "viewer" });
  const roleRequest = await changed;
  if (
    roleRequest.method() !== "PATCH" ||
    roleRequest.postDataJSON().role !== "viewer"
  )
    throw new Error("The role action sent the wrong request.");
  await member.getByRole("alert").waitFor();
  if ((await selectValue(member.getByRole("combobox"))) !== "operator")
    throw new Error("A refused role change replaced the saved role.");
  await member.screenshot({ path: `${artifacts}/member-role-refused.png` });
  await member
    .getByRole("button", { name: "Remove member", exact: true })
    .click();
  await member
    .getByRole("button", { name: "Confirm member removal", exact: true })
    .waitFor();
  await member.screenshot({
    path: `${artifacts}/member-remove-confirmation.png`,
  });
  const removed = page.waitForRequest("**/members/user_operator");
  await member
    .getByRole("button", { name: "Confirm member removal", exact: true })
    .click();
  if ((await removed).method() !== "DELETE")
    throw new Error("Member removal sent the wrong method.");
  await member.getByRole("alert").waitFor();
  await member.screenshot({ path: `${artifacts}/member-remove-refused.png` });
  const invitation = page
    .locator(".account-row")
    .filter({ hasText: "pastry-team@example.test" });
  await invitation.getByRole("button", { name: "Revoke", exact: true }).click();
  await invitation.screenshot({
    path: `${artifacts}/invitation-revoke-confirmation.png`,
  });
  const revoked = page.waitForRequest(
    "**/invitations/invitation_pastry/revoke",
  );
  await invitation
    .getByRole("button", { name: "Confirm revoke", exact: true })
    .click();
  await revoked;
  await invitation.getByRole("alert").waitFor();
  await invitation.screenshot({
    path: `${artifacts}/invitation-revoke-refused.png`,
  });
  const email = page.getByRole("textbox", {
    name: "Google account email",
    exact: true,
  });
  await email.fill("seasonal-pastry-operations@example.test");
  await chooseOption(
    page,
    page.getByRole("combobox", { name: "Role", exact: true }),
    { value: "viewer" },
  );
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await page.locator(".inline-form").getByRole("alert").waitFor();
  if ((await email.inputValue()) !== "seasonal-pastry-operations@example.test")
    throw new Error("Failed invitation erased the entered email.");
  await page
    .locator(".inline-form")
    .screenshot({ path: `${artifacts}/invitation-create-refused.png` });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate("document.documentElement.dataset.portalTheme = 'dark'");
  await page
    .getByRole("heading", { name: "Members and roles", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${artifacts}/members-wide-dark.png` });
  return {
    status: "passed",
    lastOwnerProtected: "passed",
    memberRoleRequestAndRefusal: "passed",
    memberRemovalConfirmationAndRefusal: "passed",
    invitationRefusalPreservesForm: "passed",
    artifacts,
  };

  // The Portal Select (apps/portal/src/ui/select.tsx) is a button with role
  // combobox that opens a listbox popup. Choose by { value }, { label } or
  // { index }. { values } sets the items of a multiple Select, then Escape
  // closes its popup.
  async function chooseOption(page, trigger, choice) {
    await trigger.click();
    const popup = page.locator('.pantry-select-popup[data-open]');
    await popup.waitFor();
    const items = popup.locator('.pantry-select-item');
    if ("values" in choice) {
      const wanted = choice.values.map(String);
      for (const item of await items.all()) {
        const chosen = wanted.includes(await item.getAttribute("data-value"));
        const selected = (await item.getAttribute("aria-selected")) === "true";
        if (chosen !== selected) await item.click();
      }
      await page.keyboard.press("Escape");
    } else if ("value" in choice) {
      await popup
        .locator(
          `.pantry-select-item[data-value=${JSON.stringify(String(choice.value))}]`,
        )
        .click();
    } else if ("label" in choice) {
      await popup.getByRole("option", { name: choice.label, exact: true }).click();
    } else {
      await items.nth(choice.index).click();
    }
    await popup.waitFor({ state: "hidden" });
  }

  // The form value of a Portal Select. Base UI keeps it in a hidden input that
  // it renders after the Select's parts.
  function selectValue(trigger) {
    return trigger.evaluate(function hiddenSelectValue(button) {
      for (let node = button; node !== null; node = node.parentElement) {
        for (
          let next = node.nextElementSibling;
          next !== null;
          next = next.nextElementSibling
        ) {
          if (
            next instanceof HTMLInputElement &&
            next.getAttribute("aria-hidden") === "true"
          )
            return next.value;
        }
      }
      throw new Error("A Portal Select has no hidden input.");
    });
  }
}
