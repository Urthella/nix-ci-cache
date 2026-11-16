#!/usr/bin/env node
// Turns a bench run into a table. For each approach and pass it takes, from the GitHub API, the
// job's time and the time of each measured step, including the post step a cache action adds to
// save; from the job's artifact, what Nix planned to build and fetch and how big the store was;
// and from the repository's caches, how much each approach stored during the run.
//
//   node bench/report.ts RESULTS_DIR REPORT_JSON     (in a workflow, with GH_TOKEN set)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const APPROACHES = ["none", "magic-nix-cache", "cache-nix-action"] as const;
export const PASSES = ["cold", "warm"] as const;

/** The step that sets an approach up, whose post step saves its cache. */
const SETUP: Record<string, string | undefined> = {
  "magic-nix-cache": "Set up magic-nix-cache",
  "cache-nix-action": "Restore with cache-nix-action",
};

export interface Step {
  name: string;
  started_at: string | null;
  completed_at: string | null;
  conclusion: string | null;
}
export interface Job {
  name: string;
  started_at: string;
  completed_at: string | null;
  conclusion: string | null;
  steps?: Step[];
}
export interface Cache {
  key: string;
  ref: string;
  created_at: string;
  size_in_bytes: number;
}
export interface Plan {
  built: number;
  fetched: number;
  downloadMiB: number;
}
export interface Result {
  approach: string;
  pass: string;
  plan: Plan;
  storeBytes: number;
}
export interface Row extends Result {
  conclusion: string;
  /** Seconds, or undefined when the step didn't run. */
  job?: number;
  install?: number;
  restore?: number;
  build?: number;
  shell?: number;
  save?: number;
}

const UNITS: Record<string, number> = { KiB: 1 / 1024, MiB: 1, GiB: 1024 };

/** What `nix build --dry-run` says it would do. */
export function parsePlan(text: string): Plan {
  const built = /these (\d+) derivations will be built/.exec(text)?.[1] ?? (/this derivation will be built/.test(text) ? "1" : "0");
  const many = /these (\d+) paths will be fetched \(([\d.]+) (KiB|MiB|GiB) download/.exec(text);
  const one = /this path will be fetched \(([\d.]+) (KiB|MiB|GiB) download/.exec(text);
  const fetched = many ? Number(many[1]) : one ? 1 : 0;
  const size = many ? Number(many[2]) * UNITS[many[3]] : one ? Number(one[1]) * UNITS[one[2]] : 0;
  return { built: Number(built), fetched, downloadMiB: Math.round(size * 10) / 10 };
}

const seconds = (start: string | null, end: string | null) => (start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : undefined);
const stepTime = (job: Job | undefined, name: string | undefined) => {
  const step = name === undefined ? undefined : job?.steps?.find((s) => s.name === name && s.conclusion !== "skipped");
  return step && seconds(step.started_at, step.completed_at);
};

/**
 * A reusable workflow's job is named after the caller, its matrix and the called job, as in
 * "cold (none) / measure"; the matrix part is matched as a whole word so one approach can't
 * match another.
 */
export function jobFor(jobs: Job[], pass: string, approach: string): Job | undefined {
  const matrix = /^(\w+) \(([^)]*)\)/;
  return jobs.find((job) => {
    const [, caller, values] = matrix.exec(job.name) ?? [];
    return caller === pass && values?.split(", ").includes(approach);
  });
}

export function rows(jobs: Job[], results: Result[]): Row[] {
  const order = (r: Result) => APPROACHES.indexOf(r.approach as never) * 10 + PASSES.indexOf(r.pass as never);
  return [...results].sort((a, b) => order(a) - order(b)).map((result) => {
    const job = jobFor(jobs, result.pass, result.approach);
    const setup = SETUP[result.approach];
    return {
      ...result,
      conclusion: job?.conclusion ?? "missing",
      job: job && seconds(job.started_at, job.completed_at),
      install: stepTime(job, "Install Nix"),
      restore: stepTime(job, setup),
      build: stepTime(job, "Build"),
      shell: stepTime(job, "Enter the dev shell"),
      save: stepTime(job, setup && `Post ${setup}`),
    };
  });
}

/**
 * What each approach stored during the run: cache-nix-action under its "bench-" key for the run,
 * and magic-nix-cache everything else the run's ref created after it started, since no other
 * step writes to the cache.
 */
export function cacheBytes(caches: Cache[], ref: string, since: string, run: string): Record<string, number> {
  const mine = caches.filter((cache) => cache.ref === ref && Date.parse(cache.created_at) >= Date.parse(since));
  const sum = (list: Cache[]) => list.reduce((total, cache) => total + cache.size_in_bytes, 0);
  return {
    "cache-nix-action": sum(mine.filter((cache) => cache.key.startsWith("bench-") && cache.key.endsWith(run))),
    "magic-nix-cache": sum(mine.filter((cache) => !cache.key.startsWith("bench-"))),
  };
}

const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;
const time = (s: number | undefined) => (s === undefined ? "–" : s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`);

export function markdown(table: Row[], stored: Record<string, number>): string {
  const lines = [
    "| Approach | Pass | Job | Install Nix | Restore | Build | Dev shell | Save | Built | Fetched | Store | Cache stored |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of table) {
    const result = row.conclusion === "success" ? "" : ` (${row.conclusion})`;
    const cache = row.pass === "cold" && stored[row.approach] !== undefined ? mib(stored[row.approach]) : "–";
    lines.push(
      `| ${row.approach}${result} | ${row.pass} | ${time(row.job)} | ${time(row.install)} | ${time(row.restore)} | ${time(row.build)} | ${time(row.shell)} | ${time(row.save)} | ` +
        `${row.plan.built} | ${row.plan.fetched} (${row.plan.downloadMiB} MiB) | ${mib(row.storeBytes)} | ${cache} |`,
    );
  }
  return lines.join("\n");
}

/** The results each measured job uploaded, one directory per job. */
export function readResults(dir: string): Result[] {
  return readdirSync(dir).flatMap((name) => {
    const at = (file: string) => join(dir, name, file);
    if (!existsSync(at("approach"))) return [];
    return [{
      approach: readFileSync(at("approach"), "utf8").trim(),
      pass: readFileSync(at("pass"), "utf8").trim(),
      plan: parsePlan(readFileSync(at("plan.txt"), "utf8")),
      storeBytes: Number(readFileSync(at("store-bytes"), "utf8").trim()),
    }];
  });
}

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "nix-ci-cache" },
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

if (import.meta.main) {
  const [dir, out] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  const id = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  if (!dir || !out || !repo || !id) {
    console.error("usage: GITHUB_REPOSITORY=… GITHUB_RUN_ID=… GH_TOKEN=… node bench/report.ts RESULTS_DIR REPORT_JSON");
    process.exitCode = 2;
  } else {
    const run = await api<{ created_at: string; head_branch: string; event: string; pull_requests: { number: number }[] }>(`/repos/${repo}/actions/runs/${id}`);
    const { jobs } = await api<{ jobs: Job[] }>(`/repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`);
    const { actions_caches } = await api<{ actions_caches: Cache[] }>(`/repos/${repo}/actions/caches?per_page=100&sort=created_at&direction=desc`);
    const ref = run.event === "pull_request" && run.pull_requests[0] ? `refs/pull/${run.pull_requests[0].number}/merge` : `refs/heads/${run.head_branch}`;
    const table = rows(jobs, readResults(dir));
    const stored = cacheBytes(actions_caches, ref, run.created_at, `${id}-${attempt}`);
    writeFileSync(out, JSON.stringify({ run: { id, attempt, ref, created_at: run.created_at }, rows: table, cacheBytes: stored }, null, 2) + "\n");
    console.log(markdown(table, stored));
  }
}
