import { personIds, samePerson } from "../../directory/person.ts";
import { resolverFor } from "./connectors.ts";
import type { ApiCtx } from "./route.ts";

export async function nativeSlackConfigured(ctx: ApiCtx): Promise<boolean> {
  try {
    await resolverFor(ctx.deps)("slack", {});
    return Boolean(ctx.deps.connectorTokens);
  } catch {
    return false;
  }
}

export async function nativeSlackConnection(ctx: ApiCtx) {
  const principal = ctx.actor!.p;
  for (const id of personIds(principal)) {
    for (const accountType of ["default", "personal", "company"]) {
      const auth = await ctx.deps.connectorTokens?.connectorDerivedAuth("slack.com", id, accountType);
      if (!auth) continue;
      const call = async (method: string, payload?: Record<string, unknown>, token = auth.accessToken) => {
        const url = new URL(`https://slack.com/api/${method}`);
        const sending = method === "chat.postMessage";
        if (!sending)
          for (const [name, value] of Object.entries(payload ?? {})) url.searchParams.set(name, String(value));
        const response = await (ctx.deps.slackInstallationFetch ?? fetch)(url, {
          method: sending ? "POST" : "GET",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
          ...(sending ? { body: JSON.stringify(payload ?? {}) } : {}),
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error("Slack request failed");
        return (await response.json()) as {
          ok?: boolean;
          bot_id?: string;
          user_id?: string;
          team_id?: string;
          user?: string;
          team?: string;
          ts?: string;
        };
      };
      const identity = await call("auth.test");
      if (!identity.ok || identity.bot_id || !identity.user_id || !identity.team_id) continue;
      const members = (await ctx.deps.directory?.list()) ?? [];
      const member = members.find(
        (m) =>
          (m.slackId === identity.user_id || m.principalId === identity.user_id) &&
          samePerson(m.principalId, principal),
      );
      if (!member || member.type !== "internal") continue;
      const installation = await ctx.deps.slackInstallation?.get();
      let teamId = installation?.teamId;
      if (!teamId && ctx.deps.slackEnvBotToken) {
        const bot = await call("auth.test", undefined, ctx.deps.slackEnvBotToken);
        if (bot.ok) teamId = bot.team_id;
      }
      if (!teamId || teamId !== identity.team_id) continue;
      return { call, user: identity.user ?? member.displayName, workspace: identity.team };
    }
  }
  return null;
}
