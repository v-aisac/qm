import {
  createAutomationStore,
  type AutomationStore,
  type CreateAutomationInput,
  type AutomationPatch,
} from "../triggers/automation-store.ts";
import { createMemoryAutomationRunStore, type AutomationRunStore } from "../triggers/run-store.ts";
import type { AutomationRun } from "../types.ts";
import type { Webhook } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { contentPart } from "../triggers/trigger-store.ts";
import { getVerifier } from "./verifiers.ts";

export interface CreateWebhookInput extends CreateAutomationInput {
  action: string;
  verification: Webhook["verification"];
  filters?: Webhook["filters"];
}

export interface WebhookEvent {
  deliveryId: string;
  receivedAt: number;
  payload: string;
}

export interface WebhookHistory {
  events: WebhookEvent[];
}

export interface WebhookStore extends AutomationStore<Webhook, CreateWebhookInput, AutomationPatch> {
  recordEvent(id: string, event: WebhookEvent): Promise<WebhookEvent>;
  listEvents(id: string): Promise<WebhookEvent[]>;
  beginFire(id: string, entry: AutomationRun): Promise<void>;
  finishFire(id: string, entry: AutomationRun): Promise<void>;
  listFires(id: string, opts?: { limit?: number }): Promise<{ runs: AutomationRun[]; total: number }>;

  recordFire(id: string, info: { at: number; deliveryId?: string; error?: string }): Promise<void>;
}

export function createWebhookStore(
  backing: DurableMap<Webhook> = createMemoryMap<Webhook>(),
  history: DurableMap<WebhookHistory> = createMemoryMap<WebhookHistory>(),
  fires: AutomationRunStore = createMemoryAutomationRunStore(),
): WebhookStore {
  const runId = (id: string) => `webhook:${id}`;
  const withReceipt = async (webhook: Webhook): Promise<Webhook> => {
    const events = (await history.get(webhook.id))?.events ?? [];
    const { runs } = await fires.listByCron(runId(webhook.id), { limit: 1 });
    const latest = runs[0];
    const lastReceivedAt = Math.max(0, latest?.firedAt ?? 0, ...events.map((event) => event.receivedAt));
    const lastRun = latest ? { firedAt: latest.firedAt, endedAt: latest.endedAt, status: latest.status } : undefined;
    return {
      ...webhook,
      ...(lastReceivedAt ? { lastReceivedAt, lastFiredAt: lastReceivedAt } : {}),
      ...(lastRun ? { lastRun } : {}),
    };
  };
  const management = createAutomationStore<Webhook, CreateWebhookInput, AutomationPatch>(backing, {
    present: withReceipt,
    reactivateDuplicate: true,
    create(input) {
      if (!getVerifier(input.verification.scheme) || !input.verification.secret) {
        throw new Error("webhook verification requires a supported signed scheme and secret");
      }
      if (
        input.filters?.some(
          (filter) => !filter.path.trim() || filter.in.length === 0 || filter.in.some((value) => !value.trim()),
        )
      ) {
        throw new Error("every webhook filter requires a path and at least one value");
      }
      const filters = input.filters?.length ? input.filters : undefined;
      const identity = [
        contentPart(input.owner),
        contentPart(input.ownerScopeId),
        contentPart(input.action),
        contentPart(input.verification),
        contentPart(filters),
        contentPart(input.destination),
      ];
      return {
        identity,
        fields: {
          verification: input.verification,
          ...(filters ? { filters } : {}),
        },
      };
    },
    update(_before, patch) {
      if (patch.action !== undefined && !patch.action.trim()) throw new Error("an action is required");
      return patch.action !== undefined ? { action: patch.action.trim() } : {};
    },
  });
  return {
    ...management,
    async recordEvent(id, event) {
      const fireKey = `webhook:${id}:${event.deliveryId}`;
      const legacy = (await history.get(id))?.events.find((item) => item.deliveryId === event.deliveryId);
      const original = legacy ?? event;
      const accepted = await fires.accept(runId(id), {
        fireKey,
        threadRef: fireKey,
        firedAt: original.receivedAt,
        status: "queued",
        payload: original.payload.slice(0, 16_100),
        deliveryId: original.deliveryId,
      });
      return {
        deliveryId: event.deliveryId,
        receivedAt: accepted.firedAt,
        payload: accepted.payload ?? original.payload,
      };
    },
    async listEvents(id) {
      const { runs } = await fires.listByCron(runId(id), { limit: 50 });
      const byDelivery = new Map(((await history.get(id))?.events ?? []).map((event) => [event.deliveryId, event]));
      for (const run of runs) {
        if (run.deliveryId !== undefined && run.payload !== undefined)
          byDelivery.set(run.deliveryId, { deliveryId: run.deliveryId, receivedAt: run.firedAt, payload: run.payload });
      }
      return [...byDelivery.values()]
        .sort((a, b) => b.receivedAt - a.receivedAt || a.deliveryId.localeCompare(b.deliveryId))
        .slice(0, 50);
    },
    async beginFire(id, entry) {
      await fires.record(runId(id), entry);
    },
    async finishFire(id, entry) {
      await fires.record(runId(id), entry);
    },
    listFires: (id, opts) => fires.listByCron(runId(id), opts),
    async recordFire(id, info) {
      await backing.merge(id, {
        lastFiredAt: info.at,
        ...(info.deliveryId ? { lastDeliveryId: info.deliveryId } : {}),
        lastError: info.error,
      });
    },
  };
}
