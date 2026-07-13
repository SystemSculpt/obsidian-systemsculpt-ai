/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { VersionUpdateModal } from "../VersionUpdateModal";

describe("VersionUpdateModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the update-available state with obvious actions", () => {
    const onPrimaryAction = jest.fn();
    const onClose = jest.fn();

    const modal = new VersionUpdateModal(new App(), {
      variant: "available",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      onPrimaryAction,
      onClose,
    });

    modal.open();

    expect(document.body.textContent).toContain("Update available");
    expect(document.body.textContent).toContain("Version 2.0.0 is available.");
    expect(document.body.textContent).toContain("v1.0.0");
    expect(document.body.textContent).toContain("v2.0.0");
    expect(document.body.textContent).toContain("Not now");
    expect(document.body.textContent).toContain("Update");

    const updateButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent === "Update"
    ) as HTMLButtonElement;
    updateButton.click();

    expect(onPrimaryAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the post-update state with changelog action", () => {
    const onPrimaryAction = jest.fn();

    const modal = new VersionUpdateModal(new App(), {
      variant: "updated",
      currentVersion: "2.0.0",
      onPrimaryAction,
    });

    modal.open();

    expect(document.body.textContent).toContain("SystemSculpt updated");
    expect(document.body.textContent).toContain("Update completed successfully.");
    expect(document.body.textContent).toContain("v2.0.0");
    expect(document.body.textContent).toContain("View changelog");
  });
});
