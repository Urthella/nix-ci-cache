import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { type Cache, type Job, type Result, cacheBytes, jobFor, markdown, parsePlan, readResults, rows } from "../bench/report.ts";

// Nix 2.34's own lines, from a dry run of this flake's workload and of nixpkgs#hello.
const COLD_PLAN = "these 5 derivations will be built:\n  /nix/store/a.drv\nthese 101 paths will be fetched (648.4 MiB download, 2.2 GiB unpacked):\n  /nix/store/b\n";
const ONE_PATH = "this path will be fetched (74.2 KiB download, 273.0 KiB unpacked):\n  /nix/store/c\n";

test("Nix's dry-run plan is read in all its forms", () => {
  assert.deepEqual(parsePlan(COLD_PLAN), { built: 5, fetched: 101, downloadMiB: 648.4 });
  assert.deepEqual(parsePlan(ONE_PATH), { built: 0, fetched: 1, downloadMiB: 0.1 });
  assert.deepEqual(parsePlan("this derivation will be built:\n  /nix/store/d.drv\n"), { built: 1, fetched: 0, downloadMiB: 0 });
  assert.deepEqual(parsePlan("these 3 paths will be fetched (1.5 GiB download, 4.0 GiB unpacked):"), { built: 0, fetched: 3, downloadMiB: 1536 });
  assert.deepEqual(parsePlan(""), { built: 0, fetched: 0, downloadMiB: 0 }, "nothing to do");
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 16, 12, 0, s)).toISOString();
const step = (name: string, from: number, to: number, conclusion = "success") => ({ name, started_at: at(from), completed_at: at(to), conclusion });
/** A job that ends when its last step does. */
const job = (name: string, steps: ReturnType<typeof step>[], conclusion = "success"): Job => ({ name, started_at: at(0), completed_at: steps.at(-1)!.completed_at, conclusion, steps });
const measured = (setup: ReturnType<typeof step>[], build: number, shell: number, post: ReturnType<typeof step>[] = []) => [
  step("Set up job", 0, 1),
  step("Run actions/checkout@v7", 1, 2),
  step("Install Nix", 2, 20),
  ...setup,
  step("Plan the build", 30, 35),
  step("Build", 35, 35 + build),
  step("Enter the dev shell", 35 + build, 35 + build + shell),
  ...post,
];

const JOBS: Job[] = [
  job("cold (none) / measure", measured([step("Set up magic-nix-cache", 20, 20, "skipped"), step("Restore with cache-nix-action", 20, 20, "skipped")], 200, 30)),
  job("cold (magic-nix-cache) / measure", measured([step("Set up magic-nix-cache", 20, 25), step("Restore with cache-nix-action", 25, 25, "skipped")], 210, 31, [step("Post Set up magic-nix-cache", 300, 340)])),
  job("cold (cache-nix-action) / measure", measured([step("Set up magic-nix-cache", 20, 20, "skipped"), step("Restore with cache-nix-action", 20, 22)], 205, 30, [step("Post Restore with cache-nix-action", 300, 395)])),
  job("warm (none) / measure", measured([], 199, 29)),
  job("warm (magic-nix-cache) / measure", measured([step("Set up magic-nix-cache", 20, 26)], 40, 30, [step("Post Set up magic-nix-cache", 120, 121)])),
  job("warm (cache-nix-action) / measure", measured([step("Restore with cache-nix-action", 20, 80)], 3, 1, [step("Post Restore with cache-nix-action", 120, 121)]), "failure"),
  job("cold (hestia) / measure", measured([step("Set up hestia", 20, 23)], 208, 30, [step("Post Set up hestia", 300, 330)])),
  job("warm (hestia) / measure", measured([step("Set up hestia", 20, 24)], 20, 25, [step("Post Set up hestia", 120, 122)])),
];

const result = (approach: string, pass: string, built: number): Result => ({ approach, pass, plan: { built, fetched: built ? 101 : 0, downloadMiB: built ? 648.4 : 0 }, storeBytes: 3 * 1024 ** 3 });

test("jobs are found by pass and approach, and one approach never matches another", () => {
  assert.equal(jobFor(JOBS, "warm", "magic-nix-cache")?.name, "warm (magic-nix-cache) / measure");
  assert.equal(jobFor(JOBS, "cold", "cache-nix-action")?.name, "cold (cache-nix-action) / measure");
  assert.equal(jobFor([{ ...JOBS[0], name: "cold (cache-nix-action-v2) / measure" }], "cold", "cache-nix-action"), undefined);
  assert.equal(jobFor(JOBS, "lukewarm", "none"), undefined);
});

test("each row takes its job's step times, post steps and skipped steps included", () => {
  const table = rows(JOBS, [result("cache-nix-action", "warm", 0), result("none", "cold", 5), result("magic-nix-cache", "cold", 5)]);
  assert.deepEqual(table.map((row) => `${row.approach}/${row.pass}`), ["none/cold", "magic-nix-cache/cold", "cache-nix-action/warm"], "in table order");
  const [none, mnc, cna] = table;
  assert.deepEqual([none.install, none.restore, none.build, none.shell, none.save], [18, undefined, 200, 30, undefined], "a skipped setup step isn't timed");
  assert.deepEqual([mnc.restore, mnc.build, mnc.save, mnc.job], [5, 210, 40, 340]);
  assert.deepEqual([cna.restore, cna.build, cna.shell, cna.save, cna.conclusion], [60, 3, 1, 1, "failure"]);
  assert.equal(rows([], [result("none", "cold", 5)])[0].conclusion, "missing");
  const hestia = rows(JOBS, [result("hestia", "warm", 0)])[0];
  assert.deepEqual([hestia.restore, hestia.build, hestia.save], [4, 20, 2], "Hestia's setup and post steps");
  const unset = rows([job("cold (magic-nix-cache) / measure", measured([step("Set up magic-nix-cache", 20, 20, "skipped")], 10, 10))], [result("magic-nix-cache", "cold", 5)])[0];
  assert.equal(unset.restore, undefined, "an approach whose own setup was skipped shows no restore time, not 0s");
});

test("cache sizes are counted per approach, for this run's ref and time", () => {
  const cache = (key: string, ref: string, created: number, size: number): Cache => ({ key, ref, created_at: at(created), size_in_bytes: size });
  const caches = [
    cache("bench-Linux-77-1", "refs/heads/main", 300, 2_000),
    cache("bench-Linux-66-1", "refs/heads/main", 300, 9_000), // another run
    cache("1a2b3c-narinfo", "refs/heads/main", 310, 30),
    cache("4d5e6f-nar", "refs/heads/main", 311, 300),
    cache("7a8b9c-nar", "refs/pull/3/merge", 312, 5_000), // another ref
    cache("0f0f0f-nar", "refs/heads/main", -100, 7_000), // before the run
    cache(`pack-${"3a".repeat(32)}`, "refs/heads/main", 320, 60_000),
    cache("m3#7", "refs/heads/main", 330, 4_000),
    cache(`pack-${"3a".repeat(31)}`, "refs/heads/main", 330, 1), // not a SHA-256: not Hestia's
  ];
  assert.deepEqual(cacheBytes(caches, "refs/heads/main", at(0), "77-1"), { "cache-nix-action": 2_000, hestia: 64_000, "magic-nix-cache": 331 });
});

test("the table shows minutes, failures and what each cold pass stored", () => {
  const table = rows(JOBS, [result("none", "cold", 5), result("cache-nix-action", "warm", 0), result("cache-nix-action", "cold", 5)]);
  const text = markdown(table, { "cache-nix-action": 1536 * 1024 * 1024, "magic-nix-cache": 0 });
  const lines = text.split("\n");
  assert.equal(lines.length, 5);
  assert.match(lines[2], /^\| none \| cold \| 4m 25s \| 18s \| – \| 3m 20s \| 30s \| – \| 5 \| 101 \(648.4 MiB\) \| 3072 MiB \| – \|$/);
  assert.match(lines[3], /^\| cache-nix-action \| cold \| .+ \| 1m 35s \| .+ \| 1536 MiB \|$/);
  assert.match(lines[4], /^\| cache-nix-action \(failure\) \| warm \| .+ \| 1m 00s \| 3s \| 1s \| 1s \| 0 \| 0 \(0 MiB\) \| .+ \| – \|$/);
});

const dir = mkdtempSync(join(tmpdir(), "nix-ci-cache-"));
after(() => rmSync(dir, { recursive: true, force: true }));
function artifact(approach: string, pass: string, plan: string) {
  const path = join(dir, "results", `result-${approach}-${pass}`);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "approach"), `${approach}\n`);
  writeFileSync(join(path, "pass"), `${pass}\n`);
  writeFileSync(join(path, "plan.txt"), plan);
  writeFileSync(join(path, "store-bytes"), "3221225472\n");
}
for (const approach of ["none", "magic-nix-cache", "cache-nix-action", "hestia"]) {
  artifact(approach, "cold", COLD_PLAN);
  artifact(approach, "warm", approach === "none" ? COLD_PLAN : "");
}

test("results are read from the downloaded artifacts", () => {
  const results = readResults(join(dir, "results"));
  assert.equal(results.length, 8);
  assert.deepEqual(results.find((r) => r.approach === "cache-nix-action" && r.pass === "warm")?.plan, { built: 0, fetched: 0, downloadMiB: 0 });
});

test("end to end, against a fake GitHub API", async () => {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(`${request.url} ${request.headers.authorization}`);
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (body: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/repos/me/bench/actions/runs/77") return send({ created_at: at(-5), head_branch: "main", event: "push", pull_requests: [] });
    if (url.pathname === "/repos/me/bench/actions/runs/78") return send({ created_at: at(-5), head_branch: "feature", event: "pull_request", pull_requests: [{ number: 3 }] });
    if (/^\/repos\/me\/bench\/actions\/runs\/7[78]\/attempts\/1\/jobs$/.test(url.pathname)) return send({ jobs: JOBS });
    if (url.pathname === "/repos/me/bench/actions/caches") return send({ actions_caches: [{ key: "bench-Linux-77-1", ref: "refs/heads/main", created_at: at(300), size_in_bytes: 1024 ** 3 }] });
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const report = (run: string) => {
      const env = { ...process.env, GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, GITHUB_REPOSITORY: "me/bench", GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: "1", GH_TOKEN: "t0ken" };
      return new Promise<{ code: number; text: string }>((resolve) =>
        execFile(process.execPath, [fileURLToPath(new URL("../bench/report.ts", import.meta.url)), join(dir, "results"), join(dir, `report-${run}.json`)], { env }, (error, stdout, stderr) =>
          resolve({ code: error ? Number(error.code) : 0, text: stdout + stderr }),
        ),
      );
    };
    const out = await report("77");
    assert.equal(out.code, 0, out.text);
    assert.equal(out.text.trim().split("\n").length, 10, "a header, a rule and eight rows");
    assert.match(out.text, /\| cache-nix-action \| cold \| .+ \| 1024 MiB \|/);
    const saved = JSON.parse(readFileSync(join(dir, "report-77.json"), "utf8"));
    assert.deepEqual(saved.run, { id: "77", attempt: "1", ref: "refs/heads/main", created_at: at(-5) });
    assert.equal(saved.rows.length, 8);
    assert.deepEqual(saved.rows.filter((row: { conclusion: string }) => row.conclusion === "missing"), [], "every result found its job");
    assert.ok(asked.every((line) => line.endsWith("Bearer t0ken")), "every request carries the token");

    const pr = await report("78");
    assert.equal(pr.code, 0, pr.text);
    assert.equal(JSON.parse(readFileSync(join(dir, "report-78.json"), "utf8")).run.ref, "refs/pull/3/merge", "a pull request's caches live under its merge ref");
    assert.match(pr.text, /\| cache-nix-action \| cold \| .+ \| 0 MiB \|/, "the main branch's cache isn't counted for the PR");
  } finally {
    server.close();
  }
});
