import { App, Modal, Setting, Notice } from "obsidian";

export interface UpdateNotificationWarningResult {
    confirmed: boolean;
}

export class UpdateNotificationWarningModal extends Modal {
    private result: UpdateNotificationWarningResult = { confirmed: false };
    private resolve: (value: UpdateNotificationWarningResult) => void = () => {};

    constructor(app: App) {
        super(app);
    }

    async open(): Promise<UpdateNotificationWarningResult> {
        return new Promise((resolve) => {
            this.resolve = resolve;
            super.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        // Add warning icon and title
        const headerEl = contentEl.createDiv({ cls: "modal-header" });
        const iconEl = headerEl.createDiv({ cls: "modal-header-icon" });
        iconEl.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <path d="M12 9v4"/>
                <path d="m12 17 .01 0"/>
            </svg>
        `;
        iconEl.addClass("ss-modal-icon--warning");

        const titleEl = headerEl.createDiv({ cls: "modal-title" });
        titleEl.textContent = "Disable Update Notifications";

        // Add warning message
        const messageEl = contentEl.createDiv({ cls: "modal-content" });
        messageEl.innerHTML = `
            <p><strong>Warning:</strong> Disabling update notifications means you'll be responsible for manually checking for plugin updates.</p>
            
            <p>Without notifications, you may miss important updates that include:</p>
            <ul>
                <li>Security fixes and bug patches</li>
                <li>New features and improvements</li>
                <li>Compatibility updates for new Obsidian versions</li>
                <li>Performance optimizations</li>
            </ul>
            
            <p>If you're not on the latest version, some features may stop working or behave unexpectedly.</p>
            
            <p><strong>Recommendation:</strong> Keep update notifications enabled to stay current with the latest improvements and fixes.</p>
            
            <p>You can re-enable notifications at any time in the Advanced settings tab.</p>
        `;

        // Add buttons
        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        
        new Setting(buttonContainer)
            .addButton((btn) => {
                btn.setButtonText("Cancel")
                    .onClick(() => {
                        this.result.confirmed = false;
                        this.close();
                    });
            })
            .addButton((btn) => {
                btn.setButtonText("Disable Notifications")
                    .setWarning()
                    .onClick(() => {
                        this.result.confirmed = true;
                        this.close();
                    });
            });
    }

    onClose() {
        this.resolve(this.result);
    }
}