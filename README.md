# nix-ci-cache

How much does a Nix cache save on GitHub Actions, and what does it cost? This repository builds
the same workload with each caching approach: first in a cold job, then again in a warm job that
can use what the cold one saved. It reports how long each step took, what Nix had to build and
fetch, and how much each approach stored, in every run's summary.

The approaches, each with its own defaults:

- **none**: Nix as installed, fetching from cache.nixos.org.
- **[magic-nix-cache](https://github.com/DeterminateSystems/magic-nix-cache-action)**: a daemon
  that stores what the job built in the GitHub Actions cache, one entry per store path. Paths
  that cache.nixos.org has are left out. Its diagnostics, which go to Determinate Systems by
  default, are turned off.
- **[cache-nix-action](https://github.com/nix-community/cache-nix-action)**: saves the whole
  `/nix/store` as one GitHub Actions cache entry and restores it in the next job.
- **[Hestia](https://github.com/Mic92/hestia)**: a daemon like magic-nix-cache, which packs
  paths into a few large, deduplicated cache entries instead of one per path, and says this
  makes transfers "a lot faster". By default it also keeps the paths it fetched from
  cache.nixos.org.

## Why

The GitHub Actions cache changed underneath these tools. Magic Nix Cache's free tier was shut down
on 1 February 2025 when GitHub replaced the cache API, then
[came back](https://determinate.systems/blog/bringing-back-magic-nix-cache-action) on the new
API in June 2025. The published comparisons come from vendors selling their own CI or cache. This
repository puts the free approaches side by side on the same runner and workload, with every
number coming from a run anyone can open.

## What's measured

**The workload** is [`flake.nix`](flake.nix):

- **ripgrep (Rust) and jq (C), built from source.** Each run gives them its own `BENCH_RUN`
  attribute, so their derivations are new every run. No cache can already hold them from an
  earlier one.
- **Their dependencies come from cache.nixos.org,** as in a typical project's CI. On a fresh
  runner, Nix plans to build 3 derivations and fetch 103 paths, a 648.4 MiB download.
- **A dev shell** with Node.js, the GitHub CLI and jq, entered with `nix develop`.

**The jobs** come from [`bench.yml`](.github/workflows/bench.yml):

- Each approach runs a **cold** job, then a **warm** job after all the cold ones finish.
- Both jobs of a run build the same derivations. That's all the warm job can reuse, as it runs on
  a fresh runner.
- "Cold" means something different per approach:
  - cache-nix-action's key is new every run, so its cold job really starts with nothing;
  - magic-nix-cache and Hestia name their entries by content, so a cold job can already use the
    dependencies earlier runs on the branch stored. Only the run's own builds are new. That is
    what a CI job for a new commit sees.
- Each job, from [`measure.yml`](.github/workflows/measure.yml), installs Nix with
  `cachix/install-nix-action`, sets up its approach, plans the build with `--dry-run`, builds,
  and enters the dev shell.

**The report** comes from [`bench/report.ts`](bench/report.ts):

- every step's time, from the GitHub API, including the post step a cache action adds to save;
- what the dry run said Nix would build and fetch;
- the store's size after the job;
- how much each approach stored in the Actions cache during the run.

## Results

Measured on 2026-11-16 in [this run](https://github.com/Urthella/nix-ci-cache/actions/runs/43815114504),
the second on this branch, with Nix 2.35.6 on `ubuntu-24.04`:

| Approach | Pass | Job | Install Nix | Restore | Build | Dev shell | Save | Built | Fetched | Store | Cache stored |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| none | cold | 1m 58s | 5s | – | 1m 36s | 3s | – | 3 | 103 (648.4 MiB) | 2788 MiB | – |
| none | warm | 1m 40s | 4s | – | 1m 13s | 3s | – | 3 | 103 (648.4 MiB) | 2788 MiB | – |
| magic-nix-cache | cold | 1m 59s | 4s | 11s | 1m 11s | 9s | 1s | 3 | 103 (514.2 MiB) | 3466 MiB | 17 MiB |
| magic-nix-cache | warm | 32s | 3s | 9s | 1s | 3s | 2s | 0 | 12 (0 MiB) | 1611 MiB | – |
| cache-nix-action | cold | 1m 35s | 4s | 1s | 1m 04s | 2s | 11s | 3 | 103 (648.4 MiB) | 2788 MiB | 800 MiB |
| cache-nix-action | warm | 42s | 4s | 29s | 1s | 0s | 0s | 0 | 0 (0 MiB) | 2788 MiB | – |
| hestia | cold | 1m 35s | 3s | 2s | 1m 07s | 4s | 2s | 3 | 103 (946.7 MiB) | 2788 MiB | 0 MiB |
| hestia | warm | 36s | 3s | 2s | 4s | 9s | 0s | 0 | 12 (56.9 MiB) | 932 MiB | – |

"Built" and "Fetched" are what Nix's dry run planned. "Cache stored" is what the run added to
the Actions cache.

- **Every cache cut the warm job from 1m 40s to 32–42 s**, and the build step from over a minute
  to 1–4 s. The order among them isn't stable: in
  [the branch's first run](https://github.com/Urthella/nix-ci-cache/actions/runs/43814274251), the
  warm jobs took 33 s for cache-nix-action, 43 s for Hestia and 53 s for magic-nix-cache. Without
  a cache, the same job took 1m 20s to 1m 58s across runs, so differences of 10 s are noise here.
- **Storage is where they differ:**
  - **cache-nix-action** stored the whole store, 800 MiB, under a new key every run. At that
    rate GitHub's 10 GB per-repository quota holds about a dozen runs. Its warm job spent 29 s
    restoring it.
  - **magic-nix-cache** stored 17 MiB, one narinfo and one NAR entry per path. Main's first
    run, with nothing stored yet, stored 139 MiB. Its warm job fetched only the workload's
    12 runtime paths, so its store was the smallest but one.
  - **Hestia** stored 0.3 MiB in this run. Each run's rebuilt ripgrep and jq are the same
    programs under new store paths, and its content-defined chunks dedupe what it already has.
    In the branch's first run, with nothing stored yet, it stored 214 MiB in four packs,
    dependencies included. Its warm store was the smallest, at 932 MiB.
- **magic-nix-cache's entries don't report a download size**, so Nix's plan shows its 12 paths
  as 0 KiB. Hestia's plan shows the same 12 paths as 56.9 MiB.

## Running it

Every push to `main` and every pull request runs the bench. To run it in a fork, enable Actions
there and start the bench workflow from the Actions tab. To build the workload locally:

```sh
BENCH_RUN=mine nix build --impure .#default
```

## How it's checked

- **The workload:** with NixOS-WSL, two values of `BENCH_RUN` gave two different ripgrep
  derivations, neither of them nixpkgs' own. Its vendored crates kept the same derivation, so
  they still come from cache.nixos.org.
- **The workflows** pass `actionlint` with shellcheck.
- **The report**, in [`test/report.test.ts`](test/report.test.ts):
  - Nix's dry-run wording is matched with Nix 2.34's own lines, singular and plural, in KiB,
    MiB and GiB;
  - jobs are found by pass and approach, and no approach's name can match another's;
  - step times include post steps, and skipped steps show no time rather than 0s;
  - cache sizes count only this run's entries, on its ref, telling Hestia's packs and manifests from
    magic-nix-cache's entries;
  - end to end, the script runs against a fake GitHub API, for a push and for a pull request,
    reading every page of the cache list: magic-nix-cache alone fills more than the first one.
- **Mutation testing.** Twenty-three deliberate bugs were planted in the report one at a time, and
  the tests caught every one.

## Limits

- One workload, on `ubuntu-24.04` x86-64 runners only. A bigger closure or more local builds
  would shift the balance.
- A warm job runs minutes after its cold one. Across days, GitHub may evict cache entries; its
  quota is 10 GB per repository.
- cache.nixos.org is always there, so no cold job starts from nothing. What each approach's cold
  job starts with is described under "What's measured".
- Runner and network speed vary from run to run: two runs here put the warm jobs in different
  orders.

## License

MIT
