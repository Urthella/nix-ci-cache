# nix-ci-cache

How much does a Nix cache save on GitHub Actions, and what does it cost? This repository builds
the same workload with each caching approach. First it builds with an empty cache, then again
in a second job that can use what the first one saved. It reports how long each step took, what
Nix had to build and fetch, and how much each approach stored, in every run's summary.

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
- **Their dependencies come from cache.nixos.org,** as in a typical project's CI. On a machine
  with nothing in its store, Nix plans to build 5 derivations and fetch 101 paths, a 648.4 MiB
  download.
- **A dev shell** with Node.js, the GitHub CLI and jq, entered with `nix develop`.

**The jobs** come from [`bench.yml`](.github/workflows/bench.yml):

- Each approach runs a **cold** job, then a **warm** job after all the cold ones finish.
- Both jobs of a run build the same derivations. That's all the warm job can reuse, as it runs on
  a fresh runner.
- Each job, from [`measure.yml`](.github/workflows/measure.yml), installs Nix with
  `cachix/install-nix-action`, sets up its approach, plans the build with `--dry-run`, builds,
  and enters the dev shell.

**The report** comes from [`bench/report.ts`](bench/report.ts):

- every step's time, from the GitHub API, including the post step a cache action adds to save;
- what the dry run said Nix would build and fetch;
- the store's size after the job;
- how much each approach stored in the Actions cache during the run.

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
  - end to end, the script runs against a fake GitHub API, for a push and for a pull request.
- **Mutation testing.** Twenty-two deliberate bugs were planted in the report one at a time, and
  the tests caught every one.

## Limits

- One workload, on `ubuntu-24.04` x86-64 runners only. A bigger closure or more local builds
  would shift the balance.
- A warm job runs minutes after its cold one. Across days, GitHub may evict cache entries; its
  quota is 10 GB per repository.
- cache.nixos.org is always there, so "cold" means an empty Actions cache, not an empty world.
- Runner and network speed vary from run to run, so compare approaches within one run.

## License

MIT
