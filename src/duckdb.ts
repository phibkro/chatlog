import { $ } from "bun";
import { resolve } from "node:path";
import {
  assertDerivedProjection,
  DerivedProjectionDriftError,
} from "./derived-authority";

function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function source(root: string, expectedConversations: number): string {
  const objects = `read_json_auto(${literal(resolve(root, "derived", "objects", "*", "*.json"))}, format='newline_delimited', union_by_name=true, maximum_object_size=134217728)`;
  const current = `read_json_auto(${literal(resolve(root, "derived", "current-hashes.jsonl"))}, format='newline_delimited')`;
  return `(WITH matched AS MATERIALIZED (
      SELECT d.* FROM ${objects} d SEMI JOIN ${current} c USING(conversationHash)
    ), coverage AS (
      SELECT CASE
        WHEN count(DISTINCT conversationHash) = ${expectedConversations} THEN true
        ELSE error('derived object coverage does not match the active projection')
      END AS coverage_ok
      FROM matched
    )
    SELECT matched.* FROM matched CROSS JOIN coverage WHERE coverage.coverage_ok)`;
}
async function query(sql: string): Promise<any[]> {
  let result;
  try {
    result = await $`duckdb -json -c ${sql}`.quiet();
  } catch (error: any) {
    const detail = error?.stderr?.toString().trim();
    throw new Error(detail || error?.message || "DuckDB query failed", { cause: error });
  }
  const output = result.stdout.toString().trim();
  return output ? JSON.parse(output) : [];
}
async function withDerivedProjection<T>(
  root: string,
  operation: (expectedConversations: number) => Promise<T>,
): Promise<T> {
  const before = await assertDerivedProjection(root);
  const result = await operation(before.conversations);
  const after = await assertDerivedProjection(root);
  if (
    after.contentHash !== before.contentHash
    || after.structureProjectionHash !== before.structureProjectionHash
  )
    throw new DerivedProjectionDriftError("derived projection changed while running analytics; retry");
  return result;
}
function tokenColumns(): string {
  const token = (name: string) => `coalesce(try_cast(metrics.tokens.${name} AS BIGINT),0)`;
  return `sum(CASE WHEN harness='codex' THEN greatest(${token("input")}-${token("cachedInput")},0)+${token("output")} ELSE ${token("input")}+${token("output")} END)::BIGINT AS nonCachedTokens,
    sum(${token("cachedInput")})::BIGINT AS cacheReadTokens,
    sum(${token("cacheWrite")})::BIGINT AS cacheWriteTokens,
    sum(${token("cachedInput")}+${token("cacheWrite")})::BIGINT AS cachedTokens,
    sum(${token("total")})::BIGINT AS reportedTotalTokens`;
}

export async function duckTokenUsage(root: string): Promise<unknown> {
  const rows = await withDerivedProjection(root, (expected) =>
    query(`SELECT provider, harness, count(*)::BIGINT sessions, ${tokenColumns()} FROM ${source(root, expected)} GROUP BY provider,harness ORDER BY sessions DESC`));
  return { engine: "duckdb", source: "derived current-hash projection + objects/*/*.json", rows };
}

export async function duckUsageOverTime(root: string, bucket: "day" | "month", limit: number): Promise<unknown> {
  const format = bucket === "day" ? "%Y-%m-%d" : "%Y-%m";
  const rows = await withDerivedProjection(root, (expected) =>
    query(`SELECT strftime(CAST(startedAt AS TIMESTAMP), '${format}') period, harness, model, count(*)::BIGINT sessions,
    ${tokenColumns()} FROM ${source(root, expected)} GROUP BY period,harness,model ORDER BY period DESC,reportedTotalTokens DESC LIMIT ${Math.max(1, Math.floor(limit))}`));
  return { engine: "duckdb", source: "derived current-hash projection + objects/*/*.json", bucket, rows };
}

export async function duckToolFrequency(root: string, limit: number): Promise<unknown> {
  const rows = await withDerivedProjection(root, (expected) =>
    query(`SELECT d.harness, tool.name tool, sum(tool.count)::BIGINT calls, count(DISTINCT d.conversationHash)::BIGINT sessions
    FROM ${source(root, expected)} d, UNNEST(d.metrics.toolCalls) AS u(tool)
    GROUP BY d.harness,tool.name ORDER BY calls DESC LIMIT ${Math.max(1, Math.floor(limit))}`));
  return { engine: "duckdb", source: "derived current-hash projection + objects/*/*.json", rows };
}

export async function duckSessionLengths(root: string): Promise<unknown> {
  const rows = await withDerivedProjection(root, (expected) =>
    query(`SELECT CASE WHEN metrics.turns=0 THEN '0' WHEN metrics.turns<=10 THEN '1-10'
      WHEN metrics.turns<=50 THEN '11-50' WHEN metrics.turns<=200 THEN '51-200'
      WHEN metrics.turns<=1000 THEN '201-1000' ELSE '1001+' END turnBucket,
    count(*)::BIGINT sessions, round(avg(metrics.turns),1) avgTurns, min(metrics.turns)::BIGINT minTurns, max(metrics.turns)::BIGINT maxTurns
    FROM ${source(root, expected)} GROUP BY turnBucket ORDER BY min(metrics.turns)`));
  return { engine: "duckdb", source: "derived current-hash projection + objects/*/*.json", rows };
}

export async function duckProjectAnalytics(root: string, project: string): Promise<{ overview: any; models: any[]; tools: any[] }> {
  const where = `project=${literal(project)}`;
  const [overviewRows, models, tools] = await withDerivedProjection(root, (expected) =>
    Promise.all([
      query(`SELECT count(*)::BIGINT sessions,min(startedAt) startedAt,max(endedAt) endedAt,sum(metrics.turns)::BIGINT turns,${tokenColumns()} FROM ${source(root, expected)} WHERE ${where}`),
      query(`SELECT harness,model,count(*)::BIGINT sessions,sum(metrics.turns)::BIGINT turns,${tokenColumns()} FROM ${source(root, expected)} WHERE ${where} GROUP BY harness,model ORDER BY reportedTotalTokens DESC`),
      query(`SELECT d.harness,tool.name tool,sum(tool.count)::BIGINT calls,count(DISTINCT d.conversationHash)::BIGINT sessions FROM ${source(root, expected)} d,UNNEST(d.metrics.toolCalls) AS u(tool) WHERE d.project=${literal(project)} GROUP BY d.harness,tool.name ORDER BY calls DESC LIMIT 20`),
    ]));
  return { overview: overviewRows[0] ?? null, models, tools };
}
