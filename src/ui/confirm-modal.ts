/**
 * Simple confirmation dialog.
 */

import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
  private message: string;
  private resolvePromise: ((confirmed: boolean) => void) | null = null;

  constructor(app: App, message: string) {
    super(app);
    this.message = message;
  }

  static confirm(app: App, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(app, message);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("p", { text: this.message });

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText("Confirm")
          .setCta()
          .onClick(() => {
            if (this.resolvePromise) {
              this.resolvePromise(true);
              this.resolvePromise = null;
            }
            this.close();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => {
          if (this.resolvePromise) {
            this.resolvePromise(false);
            this.resolvePromise = null;
          }
          this.close();
        });
      });
  }

  onClose(): void {
    if (this.resolvePromise) {
      this.resolvePromise(false);
      this.resolvePromise = null;
    }
    this.contentEl.empty();
  }
}
