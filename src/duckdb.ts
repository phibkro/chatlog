import { $ } from "bun";
import { resolve } from "node:path";

function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function source(root: string): string {
  const objects = `read_json_auto(${literal(resolve(root, "derived", "objects", "*", "*.json"))}, format='newline_delimited', union_by_name=true, maximum_object_size=134217728)`;
  const current = `read_json_auto(${literal(resolve(root, "derived", "current-hashes.jsonl"))}, format='newline_delimited')`;
  return `(SELECT d.* FROM ${objects} d SEMI JOIN ${current} c USING(conversationHash))`;
}
async function query(sql: string): Promise<any[]> {
  const result = await $`nix shell --offline nixpkgs#duckdb -c duckdb -json -c ${sql}`.quiet();
  const output = result.stdout.toString().trim();
  return output ? JSON.parse(output) : [];
}
function tokenColumns(): string {
  return `sum(CASE WHEN harness='codex' THEN greatest(coalesce(metrics.tokens.input,0)-coalesce(metrics.tokens.cachedInput,0),0)+coalesce(metrics.tokens.output,0) ELSE coalesce(metrics.tokens.input,0)+coalesce(metrics.tokens.output,0) END)::BIGINT AS nonCachedTokens,
    sum(coalesce(metrics.tokens.cachedInput,0))::BIGINT AS cacheReadTokens,
    sum(coalesce(metrics.tokens.cacheWrite,0))::BIGINT AS cacheWriteTokens,
    sum(coalesce(metrics.tokens.cachedInput,0)+coalesce(metrics.tokens.cacheWrite,0))::BIGINT AS cachedTokens,
    sum(coalesce(metrics.tokens.total,0))::BIGINT AS reportedTotalTokens`;
}

export async function duckTokenUsage(root: string): Promise<unknown> {
  const rows = await query(`SELECT provider, harness, count(*)::BIGINT sessions, ${tokenColumns()} FROM ${source(root)} GROUP BY provider,harness ORDER BY sessions DESC`);
  return { engine: "duckdb", source: "derived current-hash projection + objects/*/*.json", rows };
}

export async function duckUsageOverTime(root: string, bucket: "day" | "month", limit: number): Promise<unknown> {
  const format = bucket === "day" ? "%Y-%m-%d" : "%Y-%m";
  const rows = await query(`SELECT strftime(CAST(startedAt AS TIMESTAMP), '${format}') period, harness, model, count(*)::BIGINT sessions,
    ${tokenColumns()} FROM ${source(root)} GROUP BY period,harness,model ORDER BY period DESC,reportedTotalTokens DESC LIMIT ${Math.max(1, Math.floor(limit))}`);
  return { engine: "duckdb", source: "derived current-hash projection + objects/*/*.json", bucket, rows };
}

export async function duckToolFrequency(root: string, limit: number): Promise<unknown> {
  const rows = await query(`SELECT d.harness, tool.name tool, sum(tool.count)::BIGINT calls, count(DISTINCT d.conversationHash)::BIGINT sessions
    FROM ${source(root)} d, UNNEST(d.metrics.toolCalls) AS u(tool)
    GROUP BY d.harness,tool.name ORDER BY calls DESC LIMIT ${Math.max(1, Math.floor(limit))}`);
  return { engine: "duckdb", source: "derived current-hash projection + objects/*/*.json", rows };
}

export async function duckSessionLengths(root: string): Promise<unknown> {
  const rows = await query(`SELECT CASE WHEN metrics.turns=0 THEN '0' WHEN metrics.turns<=10 THEN '1-10'
      WHEN metrics.turns<=50 THEN '11-50' WHEN metrics.turns<=200 THEN '51-200'
      WHEN metrics.turns<=1000 THEN '201-1000' ELSE '1001+' END turnBucket,
    count(*)::BIGINT sessions, round(avg(metrics.turns),1) avgTurns, min(metrics.turns)::BIGINT minTurns, max(metrics.turns)::BIGINT maxTurns
    FROM ${source(root)} GROUP BY turnBucket ORDER BY min(metrics.turns)`);
  return { engine: "duckdb", source: "derived current-hash projection + objects/*/*.json", rows };
}

export async function duckProjectAnalytics(root: string, project: string): Promise<{ overview: any; models: any[]; tools: any[] }> {
  const where = `project=${literal(project)}`;
  const [overviewRows, models, tools] = await Promise.all([
    query(`SELECT count(*)::BIGINT sessions,min(startedAt) startedAt,max(endedAt) endedAt,sum(metrics.turns)::BIGINT turns,${tokenColumns()} FROM ${source(root)} WHERE ${where}`),
    query(`SELECT harness,model,count(*)::BIGINT sessions,sum(metrics.turns)::BIGINT turns,${tokenColumns()} FROM ${source(root)} WHERE ${where} GROUP BY harness,model ORDER BY reportedTotalTokens DESC`),
    query(`SELECT d.harness,tool.name tool,sum(tool.count)::BIGINT calls,count(DISTINCT d.conversationHash)::BIGINT sessions FROM ${source(root)} d,UNNEST(d.metrics.toolCalls) AS u(tool) WHERE d.project=${literal(project)} GROUP BY d.harness,tool.name ORDER BY calls DESC LIMIT 20`),
  ]);
  return { overview: overviewRows[0] ?? null, models, tools };
}
