import { LitElement, html, nothing } from "lit";
import { withBase } from "./core-bridge";
import "./slack-account";
import "./slack-reply.css";

export class SlackReply extends LitElement {
  static properties = {
    sessionId: {},
    user: {},
    connected: { state: true },
    loading: { state: true },
    sending: { state: true },
    error: { state: true },
    text: { state: true },
    label: { state: true },
    sent: { state: true },
  };
  sessionId = "";
  user = "";
  private connected = false;
  private loading = true;
  private sending = false;
  private error = "";
  private text = "";
  private label = "";
  private sent = false;
  private inputId = `slack-reply-${crypto.randomUUID()}`;

  protected createRenderRoot(): HTMLElement {
    return this;
  }
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("focus", this.refresh);
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.refresh);
  }
  protected firstUpdated(): void {
    void this.refresh();
  }
  private refresh = async (): Promise<void> => {
    try {
      const response = await this.request("reply-status");
      const result = await response.json();
      this.connected = response.ok && result.connected === true;
      this.label = result.user ?? "yourself";
      this.error = response.ok ? "" : (result.message ?? "Could not check your Slack connection.");
    } catch {
      this.connected = false;
      this.error = "Could not check your Slack connection.";
    } finally {
      this.loading = false;
    }
  };
  private request(action: string, message?: { text: string; clientMessageId: string }): Promise<Response> {
    return fetch(withBase(`/api/composio/slack/${action}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, ...message }),
      signal: AbortSignal.timeout(60_000),
    });
  }
  private async send(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.connected || this.sending || !this.text.trim()) return;
    this.sending = true;
    this.error = "";
    this.sent = false;
    try {
      const response = await this.request("reply", { text: this.text, clientMessageId: crypto.randomUUID() });
      const result = await response.json();
      if (!response.ok || !result.sent) {
        if (result.connected === false) this.connected = false;
        this.error = result.message ?? "Could not send your Slack message.";
        return;
      }
      this.text = "";
      this.sent = true;
      this.dispatchEvent(new CustomEvent("slack-sent", { bubbles: true }));
    } catch {
      this.error = "The send outcome is unknown. Check Slack before trying again.";
    } finally {
      this.sending = false;
    }
  }
  protected render() {
    if (this.loading)
      return html`<div class="slack-reply-box"><p role="status">Checking your Slack connection…</p></div>`;
    return html`<div class="slack-reply-box">
      ${
        this.connected
          ? html`<form @submit=${(e: Event) => void this.send(e)}>
              <label for=${this.inputId}>Reply in Slack as ${this.label}</label>
              <textarea
                id=${this.inputId}
                aria-label="Reply in Slack"
                placeholder="Write a reply…"
                rows="2"
                maxlength="4000"
                .value=${this.text}
                ?disabled=${this.sending}
                @input=${(e: Event) => {
                  this.text = (e.target as HTMLTextAreaElement).value;
                  this.sent = false;
                }}
              ></textarea>
              <div class="slack-reply-actions">
                <span role="status">${this.sent ? "Sent to Slack." : ""}</span>
                <button class="btn" type="submit" ?disabled=${this.sending || !this.text.trim()}>
                  ${this.sending ? "Sending…" : "Send to Slack"}
                </button>
              </div>
            </form>`
          : html`<qm-slack-account .user=${this.user} .reply=${true} @slack-linked=${this.refresh}></qm-slack-account>`
      }
      ${this.error ? html`<p class="slack-account-error" role="alert">${this.error} <button class="btn" @click=${this.refresh}>Check connection</button></p>` : nothing}
    </div>`;
  }
}
if (!customElements.get("qm-slack-reply")) customElements.define("qm-slack-reply", SlackReply);
