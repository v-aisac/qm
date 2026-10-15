import { html, nothing, render } from "lit";
import { ChevronDown, ChevronUp, Pin, PinOff, X } from "lucide";
import { api, ApiError, withBase, type CoreSession, type SessionStateEvent } from "./core-bridge.ts";
import type { ConvCtx, Conversation } from "./conv-types.ts";
import { appState } from "./shell-state.ts";
import { icon } from "./icons.ts";
import { reportHandledError } from "./browser-errors.ts";
import { errMessage, swallow } from "../../chassis/src/errors.ts";

type Owner = Pick<ConvCtx, "chat" | "composer">;

interface CanvasRecord {
  html: string;
  css: string;
  js: string;
  pinned: boolean;
  rev: number;
}

interface Panel {
  sessionId: string;
  el: HTMLElement;
  head: HTMLElement;
  shadow: ShadowRoot;
  canvas: CanvasRecord | null;
  expanded: boolean;
  owner: Owner;
  script: HTMLScriptElement | null;
  lifetime: AbortController;
  cleanups: Array<() => void>;
}

interface UiCanvasApi {
  sessionId: string;
  rev: number;
  root: ShadowRoot;
  signal: AbortSignal;
  onDispose(fn: () => void): void;
  send(text: string): Promise<boolean>;
}

type ObserveSignal = {
  kind: "observe";
  callId: string;
  selector?: string;
  css?: boolean;
  screenshot?: boolean;
  preview?: boolean;
};
type UiSignal = { kind: "canvas" } | ObserveSignal;

declare global {
  interface Window {
    qmUiCanvasTake?: (sessionId: string, rev: number) => UiCanvasApi | undefined;
    qmCanvasPreview?: { settled(): boolean; snapshot(signal: ObserveSignal): Promise<Record<string, unknown>> };
  }
}

const SNAPSHOT_BUDGET_BYTES = 700_000;
const SCREENSHOT_BUDGET_CHARS = 600_000;
const HIDDEN_TAB_DELAY_MS = 1_500;
const SENT_PREFIX = "[canvas] ";

const loaded = new Map<string, CanvasRecord | null>();
const loading = new Map<string, { dirty: boolean }>();
const panels = new Map<string, Panel>();
const handoff = new Map<string, UiCanvasApi>();
const waiting = new Map<string, Set<Owner>>();
const announced = new Set<string>();

const ALWAYS_ON = "always-on";
const PREVIEW_PARAM = "qmCanvasPreview";
const PREVIEW = typeof location !== "undefined" && new URLSearchParams(location.search).has(PREVIEW_PARAM);
const PREVIEW_TIMEOUT_MS = 25_000;
const PREVIEW_SETTLE_MS = 1_500;
const sourceQuery = new Map<string, string>();
const previewErrors: string[] = [];
let loadsDone = 0;

if (PREVIEW) {
  addEventListener("error", (e) => previewErrors.push(e.message || String(e.error)));
  addEventListener("unhandledrejection", (e) => previewErrors.push(errMessage(e.reason)));
  window.qmCanvasPreview = {
    settled: () => loadsDone > 0 && loading.size === 0,
    snapshot: async (signal) => ({ ...(await buildSnapshot(signal, [], [])), preview: true, errors: previewErrors }),
  };
}

async function fetchCanvas(sessionId: string): Promise<CanvasRecord | null> {
  const get = (query: string) =>
    api<{ canvas: CanvasRecord }>(`/api/ui-canvas/${encodeURIComponent(sessionId)}${query}`).then((r) => {
      sourceQuery.set(sessionId, query);
      return r.canvas;
    });
  if (PREVIEW)
    try {
      return await get("?draft=1");
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  return get("");
}

function take(sessionId: string, rev: number): UiCanvasApi | undefined {
  const key = `${sessionId}#${rev}`;
  const handed = handoff.get(key);
  handoff.delete(key);
  return handed;
}

function disabled(): boolean {
  return !appState.me || Boolean(appState.me.impersonatedBy);
}

function load(sessionId: string, owner?: Owner): void {
  if (owner) waiting.set(sessionId, (waiting.get(sessionId) ?? new Set()).add(owner));
  const inFlight = loading.get(sessionId);
  if (inFlight) {
    if (!owner) inFlight.dirty = true;
    return;
  }
  const state = { dirty: false };
  loading.set(sessionId, state);
  void fetchCanvas(sessionId)
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      reportHandledError("ui_canvas_load", error);
      return undefined;
    })
    .then((canvas) => {
      loading.delete(sessionId);
      loadsDone++;
      if (state.dirty) return load(sessionId);
      if (canvas === undefined) return void waiting.delete(sessionId);
      loaded.set(sessionId, canvas);
      const panel = panels.get(sessionId);
      if (panel && !canvas) disposePanel(panel);
      else if (panel && canvas) applyCanvas(panel, canvas);
      if (!canvas || panel) announced.delete(sessionId);
      for (const o of waiting.get(sessionId) ?? []) o.chat.redraw();
      if (panel) panel.owner.chat.redraw();
      waiting.delete(sessionId);
    });
}

export function uiCanvasPanel(owner: Owner): HTMLElement | typeof nothing {
  const sessionId = owner.chat.state.sessionId;
  for (const panel of panels.values())
    if (panel.owner.chat === owner.chat && panel.sessionId !== sessionId && panel.sessionId !== ALWAYS_ON)
      disposePanel(panel);
  if (disabled()) return nothing;
  mount(ALWAYS_ON, owner);
  if (sessionId) mount(sessionId, owner);
  return nothing;
}

function mount(sessionId: string, owner: Owner): void {
  if (!loaded.has(sessionId)) return load(sessionId, owner);
  const canvas = loaded.get(sessionId);
  if (!canvas) return;
  let panel = panels.get(sessionId);
  if (!panel) {
    panel = createPanel(sessionId, owner);
    applyCanvas(panel, canvas);
  }
  if (sessionId !== ALWAYS_ON || !panel.owner.chat.state.sessionId) panel.owner = owner;
  if (!panel.el.isConnected) document.body.append(panel.el);
}

export function resyncUiCanvas(open: Array<string | null>): void {
  const keep = new Set([ALWAYS_ON, ...panels.keys(), ...open.filter((id): id is string => Boolean(id))]);
  for (const sessionId of loaded.keys()) if (!keep.has(sessionId)) loaded.delete(sessionId);
  for (const sessionId of keep) load(sessionId);
}

export function releaseUiCanvas(conv: Conversation): void {
  for (const panel of panels.values()) if (panel.owner.chat === conv) disposePanel(panel);
}

let dock: HTMLElement | null = null;

function createPanel(sessionId: string, owner: Owner): Panel {
  const el = document.createElement("div");
  el.className = "ui-canvas";
  const head = document.createElement("div");
  head.className = "ui-canvas-head";
  const body = document.createElement("div");
  body.className = "ui-canvas-body";
  el.append(body);
  if (!dock) {
    dock = document.createElement("div");
    dock.className = "ui-canvas-dock";
  }
  if (!dock.isConnected) document.body.append(dock);
  dock.append(head);
  const panel: Panel = {
    sessionId,
    el,
    head,
    shadow: body.attachShadow({ mode: "open", serializable: true } as ShadowRootInit),
    canvas: null,
    expanded: false,
    owner,
    script: null,
    lifetime: new AbortController(),
    cleanups: [],
  };
  panels.set(sessionId, panel);
  return panel;
}

function cleanup(panel: Panel): void {
  panel.lifetime.abort();
  for (const fn of panel.cleanups.splice(0)) {
    try {
      fn();
    } catch (error) {
      swallow("web-ui: ui canvas cleanup", error);
    }
  }
  panel.script?.remove();
  panel.script = null;
  if (panel.canvas) handoff.delete(`${panel.sessionId}#${panel.canvas.rev}`);
}

function disposePanel(panel: Panel): void {
  cleanup(panel);
  panel.el.remove();
  panel.head.remove();
  panels.delete(panel.sessionId);
}

function applyCanvas(panel: Panel, canvas: CanvasRecord): void {
  const previous = panel.canvas;
  if (previous?.rev !== canvas.rev) {
    cleanup(panel);
    panel.lifetime = new AbortController();
    const style = document.createElement("style");
    style.textContent = canvas.css;
    const body = document.createElement("div");
    body.innerHTML = canvas.html;
    panel.shadow.replaceChildren(style, body);
    if (canvas.js.trim()) runScript(panel, canvas);
    panel.expanded = previous !== null || canvas.pinned || announced.has(panel.sessionId);
    announced.delete(panel.sessionId);
  }
  panel.canvas = canvas;
  drawHead(panel);
}

function runScript(panel: Panel, canvas: CanvasRecord): void {
  const signal = panel.lifetime.signal;
  window.qmUiCanvasTake ??= take;
  handoff.set(`${panel.sessionId}#${canvas.rev}`, {
    sessionId: panel.sessionId,
    rev: canvas.rev,
    root: panel.shadow,
    signal,
    onDispose: (fn) => {
      if (signal.aborted) fn();
      else panel.cleanups.push(fn);
    },
    send: (text) => sendFromCanvas(panel, text),
  });
  const script = document.createElement("script");
  script.src = withBase(
    `/api/ui-canvas/${encodeURIComponent(panel.sessionId)}/script.js${sourceQuery.get(panel.sessionId) || "?"}&rev=${canvas.rev}`,
  );
  script.onerror = () => {
    if (panel.script === script && !signal.aborted) load(panel.sessionId);
  };
  panel.script = script;
  panel.el.append(script);
}

function drawHead(panel: Panel): void {
  const canvas = panel.canvas;
  if (!canvas) return;
  const open = canvas.pinned || panel.expanded;
  panel.el.classList.toggle("collapsed", !open);
  panel.el.classList.toggle("pinned", canvas.pinned);
  render(
    html`<span class="ui-canvas-title" title="Written by the agent. Its code runs in this page with your session."
        >${panel.sessionId === ALWAYS_ON ? "Always-on" : "Canvas"}</span
      >
      <button
        class="icon-btn compact"
        aria-pressed=${canvas.pinned}
        title=${canvas.pinned ? "Unpin canvas" : "Pin canvas open"}
        @click=${() => void update(panel, { pinned: !canvas.pinned })}
      >
        ${icon(canvas.pinned ? PinOff : Pin, 13)}
      </button>
      ${
        canvas.pinned
          ? nothing
          : html`<button
              class="icon-btn compact"
              aria-expanded=${open}
              title=${open ? "Collapse canvas" : "Expand canvas"}
              @click=${() => {
                panel.expanded = !open;
                drawHead(panel);
              }}
            >
              ${icon(open ? ChevronUp : ChevronDown, 13)}
            </button>`
      }
      <button class="icon-btn compact" title="Close canvas" @click=${() => void update(panel, { dismiss: true })}>
        ${icon(X, 13)}
      </button>`,
    panel.head,
  );
}

async function update(panel: Panel, change: { pinned?: boolean; dismiss?: true }): Promise<void> {
  if (change.dismiss) {
    loaded.set(panel.sessionId, null);
    disposePanel(panel);
  } else if (panel.canvas && change.pinned !== undefined) {
    panel.canvas = { ...panel.canvas, pinned: change.pinned };
    loaded.set(panel.sessionId, panel.canvas);
    drawHead(panel);
  }
  await api(`/api/ui-canvas/${encodeURIComponent(panel.sessionId)}`, {
    method: "POST",
    body: JSON.stringify(change),
  }).catch((error: unknown) => {
    reportHandledError("ui_canvas_update", error);
    load(panel.sessionId);
  });
}

async function sendFromCanvas(panel: Panel, text: string): Promise<boolean> {
  const { chat, composer } = panel.owner;
  const agent = chat.state.agent;
  if (PREVIEW) return false;
  if (panel.lifetime.signal.aborted || !agent || chat.state.sessionId !== panel.sessionId || !text.trim()) return false;
  const message = SENT_PREFIX + text.trim();
  if (agent.state.isStreaming) return (await chat.signalLiveRun("steer", message)).ok;
  if (composer.state.draft || composer.state.attachments.length) return false;
  await composer.sendSuggestedPrompt(message, agent);
  return true;
}

export function handleUiSignal(
  event: SessionStateEvent & { ui?: UiSignal },
  conversations: Conversation[],
  sessions: CoreSession[],
): void {
  if (disabled() || !event.ui || PREVIEW) return;
  if (event.ui.kind === "canvas") {
    announced.add(ALWAYS_ON);
    load(ALWAYS_ON);
    const sessionId = event.sessionId;
    if (sessionId && (loaded.has(sessionId) || conversations.some((c) => c.state.sessionId === sessionId))) {
      announced.add(sessionId);
      load(sessionId);
    }
    return;
  }
  void answerObserve(event.ui, conversations, sessions);
}

async function answerObserve(
  signal: ObserveSignal,
  conversations: Conversation[],
  sessions: CoreSession[],
): Promise<void> {
  if (document.visibilityState !== "visible") await new Promise((r) => setTimeout(r, HIDDEN_TAB_DELAY_MS));
  const claim = `qm-observe:${signal.callId}`;
  if (localStorage.getItem(claim)) return;
  localStorage.setItem(claim, "1");
  setTimeout(() => localStorage.removeItem(claim), 60_000);
  const snapshot = await (
    signal.preview ? previewSnapshot(signal) : buildSnapshot(signal, conversations, sessions)
  ).catch((error: unknown) => ({
    error: errMessage(error),
  }));
  const post = (body: unknown) =>
    api(`/api/ui-canvas/observe/${encodeURIComponent(signal.callId)}`, {
      method: "POST",
      body: JSON.stringify({ snapshot: body }),
    });
  await post(snapshot)
    .catch((error: unknown) => post({ error: `the snapshot could not be delivered: ${errMessage(error)}` }))
    .catch((error: unknown) => {
      if (!(error instanceof ApiError && error.status === 404)) reportHandledError("ui_observe_deliver", error);
    });
}

async function previewSnapshot(signal: ObserveSignal): Promise<Record<string, unknown>> {
  const url = new URL(location.href);
  url.searchParams.set(PREVIEW_PARAM, "1");
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;top:0;left:${-innerWidth - 100}px;width:${innerWidth}px;height:${innerHeight}px;border:0;pointer-events:none;`;
  frame.src = url.toString();
  document.body.append(frame);
  try {
    const deadline = Date.now() + PREVIEW_TIMEOUT_MS;
    let hook: Window["qmCanvasPreview"];
    while (!(hook = frame.contentWindow?.qmCanvasPreview)?.settled()) {
      if (Date.now() > deadline) throw new Error("the preview copy of the app did not finish loading in time");
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, PREVIEW_SETTLE_MS));
    return await hook!.snapshot(signal);
  } finally {
    frame.remove();
  }
}

function stylesheetText(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      out.push(Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"));
    } catch {
      out.push(`/* unreadable stylesheet: ${sheet.href ?? "inline"} */`);
    }
  }
  return out.join("\n");
}

async function screenshot(target: HTMLElement): Promise<{ dataUrl?: string; error?: string }> {
  try {
    const { toJpeg } = await import("html-to-image");
    for (const quality of [0.7, 0.4]) {
      const dataUrl = await toJpeg(target, { quality, pixelRatio: 1 });
      if (dataUrl.length <= SCREENSHOT_BUDGET_CHARS) return { dataUrl };
    }
    return { error: "screenshot exceeded the size budget; narrow it with a selector" };
  } catch (error) {
    return { error: errMessage(error) };
  }
}

function findTarget(selector: string | undefined): Element | null {
  return selector ? document.querySelector(selector) : document.documentElement;
}

function serializeWithShadow(el: Element): string {
  const withShadow = el as Element & { getHTML?: (o: { serializableShadowRoots: boolean }) => string };
  if (!withShadow.getHTML) return el.outerHTML;
  const tag = el.tagName.toLowerCase();
  const attrs = Array.from(el.attributes, (a) => ` ${a.name}="${a.value.replace(/"/g, "&quot;")}"`).join("");
  return `<${tag}${attrs}>${withShadow.getHTML({ serializableShadowRoots: true })}</${tag}>`;
}

const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

export function fitSnapshot(
  snapshot: Record<string, unknown>,
  budget = SNAPSHOT_BUDGET_BYTES,
): Record<string, unknown> {
  const out = { ...snapshot };
  const truncated: string[] = [];
  for (const field of ["html", "css", "sessions", "screenshot"]) {
    const over = byteLength({ ...out, truncated: [...truncated, field] }) - budget;
    if (over <= 0) break;
    const value = out[field];
    if (value === undefined) continue;
    truncated.push(field);
    if (typeof value === "string" && field !== "screenshot") {
      out[field] = value.slice(0, Math.max(0, value.length - over));
      while (byteLength({ ...out, truncated }) > budget && (out[field] as string).length)
        out[field] = (out[field] as string).slice(0, Math.floor((out[field] as string).length * 0.9));
    } else delete out[field];
  }
  return truncated.length ? { ...out, truncated } : out;
}

async function buildSnapshot(
  signal: ObserveSignal,
  conversations: Conversation[],
  sessions: CoreSession[],
): Promise<Record<string, unknown>> {
  const target = findTarget(signal.selector);
  const shot = signal.screenshot && target instanceof HTMLElement ? await screenshot(target) : undefined;
  return fitSnapshot({
    url: location.href,
    title: document.title,
    at: Date.now(),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    visibility: document.visibilityState,
    focused: document.hasFocus(),
    view: appState.currentView,
    panes: conversations.map((conv) => {
      const rect = conv.state.host?.getBoundingClientRect();
      return {
        sessionId: conv.state.sessionId,
        threadRef: conv.state.threadRef,
        scopeId: conv.state.scopeId,
        context: conv.state.contextName,
        attached: Boolean(conv.state.host?.isConnected),
        streaming: Boolean(conv.state.agent?.state.isStreaming),
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      };
    }),
    canvases: [...panels.values()].map((p) => ({
      sessionId: p.sessionId,
      rev: p.canvas?.rev ?? null,
      pinned: p.canvas?.pinned ?? false,
      attached: p.el.isConnected,
      expanded: p.expanded,
    })),
    selector: signal.selector ?? null,
    found: target !== null,
    html: target ? serializeWithShadow(target) : null,
    ...(signal.css ? { css: stylesheetText() } : {}),
    ...(shot ? { screenshot: shot } : {}),
    sessions,
  });
}
