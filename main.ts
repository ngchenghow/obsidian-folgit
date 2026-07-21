import { App, Modal, Notice, Plugin } from "obsidian";

export default class FolgitPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "echo",
      name: "Echo input",
      callback: () => new EchoModal(this.app).open(),
    });
  }

  onunload() {}
}

class EchoModal extends Modal {
  private value = "";

  onOpen() {
    this.titleEl.setText("Echo");
    const input = this.contentEl.createEl("input", { type: "text" });
    input.placeholder = "Type something…";
    input.style.width = "100%";
    input.addEventListener("input", () => (this.value = input.value));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.submit();
      }
    });

    const buttons = this.contentEl.createDiv();
    buttons.style.marginTop = "1em";
    buttons.style.display = "flex";
    buttons.style.justifyContent = "flex-end";
    buttons.style.gap = "0.5em";
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const ok = buttons.createEl("button", { text: "OK", cls: "mod-cta" });
    ok.addEventListener("click", () => this.submit());

    setTimeout(() => input.focus(), 0);
  }

  private submit() {
    const value = this.value.trim();
    this.close();
    if (value) new Notice(value);
  }

  onClose() {
    this.contentEl.empty();
  }
}
