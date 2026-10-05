import { PgBoss } from "pg-boss";
import { createPgPool, type PgPool } from "../persistence/pg-pool.ts";
import { errMessage } from "../util/errors.ts";

export interface AutomationJobQueue<T> {
  start(handlers: { onFire(job: T): Promise<void> }): Promise<void>;
  enqueueFire(job: T): Promise<void>;
  healthy(): boolean;
  stopClaims?(): Promise<void>;
  stop(): Promise<void>;
}

const UNHEALTHY_AFTER_ERROR_MS = 30_000;

export function createPgBossAutomationQueue<T extends object>(
  databaseUrl: string,
  schema: string = "pgboss",
  fireConcurrency: number = 1,
  options: { name: string; key(job: T): string; startAfter(job: T): number; retryLimit: number; exclusive?: boolean },
): AutomationJobQueue<T> {
  let pg: PgPool | null = null;
  const boss = new PgBoss({
    schema,
    db: {
      executeSql: async (text, values) => {
        if (!pg) throw new Error("Automation queue database is closed");
        return (await pg.pool()).query(text, values);
      },
    },
  });
  async function closePool() {
    const previous = pg;
    pg = null;
    await previous?.close();
  }
  let started = false;
  let initialized = false;
  let lastErrorAt = 0;
  boss.on("error", (e) => {
    lastErrorAt = Date.now();
    console.error(`[${options.name}] pg-boss error:`, errMessage(e));
  });
  let preparing: Promise<void> | undefined;
  let closed = false;
  async function prepare() {
    if (closed) throw new Error("Automation queue is closed");
    if (!preparing) {
      preparing = (async () => {
        pg ??= createPgPool(databaseUrl, []);
        await boss.start();
        initialized = true;
        await boss.createQueue(options.name, { policy: options.exclusive ? "exclusive" : "short", notify: true });
      })().catch(async (error) => {
        await boss.stop({ close: true, graceful: false }).catch(() => {});
        await closePool();
        initialized = false;
        preparing = undefined;
        throw error;
      });
    }
    await preparing;
  }
  return {
    async start(handlers) {
      if (started) return;
      if (closed) {
        closed = false;
        preparing = undefined;
      }
      try {
        await prepare();
        const localConcurrency = Math.min(32, Math.max(1, Math.trunc(fireConcurrency)));
        await boss.work<T>(
          options.name,
          { pollingIntervalSeconds: 1, batchSize: 1, localConcurrency },
          async (jobs) => {
            for (const job of jobs) await handlers.onFire(job.data);
          },
        );
      } catch (e) {
        if (initialized) {
          await boss.offWork(options.name, { wait: false }).catch(() => {});
        } else {
          await boss.stop({ close: true, graceful: false }).catch(() => {});
          await closePool();
        }
        throw e;
      }
      started = true;
      lastErrorAt = 0;
    },
    async enqueueFire(job) {
      await prepare();
      await boss
        .send(options.name, job, {
          startAfter: new Date(options.startAfter(job)),
          singletonKey: options.key(job),
          retryLimit: options.retryLimit,
          retryDelay: 5,
          retryBackoff: true,
          ...(options.exclusive ? { heartbeatSeconds: 30 } : {}),
        })
        .catch((e: unknown) => {
          lastErrorAt = Date.now();
          throw e;
        });
    },
    healthy() {
      return started && Date.now() - lastErrorAt >= UNHEALTHY_AFTER_ERROR_MS;
    },
    async stopClaims() {
      started = false;
      await boss.offWork(options.name, { wait: false });
    },
    async stop() {
      started = false;
      closed = true;
      await preparing?.catch(() => {});
      try {
        await boss.stop({ close: true, graceful: false });
      } finally {
        initialized = false;
        await closePool();
      }
    },
  };
}
