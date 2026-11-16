{
  description = "nix-ci-cache: a workload for comparing Nix caches on GitHub Actions, and its dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Each benchmark run builds its own copies of the packages, so no cache can already hold them
      # from an earlier run, while their dependencies still come from cache.nixos.org as they would
      # in a project's CI. Reading the environment needs --impure.
      run = let r = builtins.getEnv "BENCH_RUN"; in if r == "" then "local" else r;
      fresh = pkg: pkg.overrideAttrs { BENCH_RUN = run; };
    in
    {
      packages = forAllSystems (pkgs: rec {
        ripgrep = fresh pkgs.ripgrep; # Rust
        jq = fresh pkgs.jq; # C
        default = pkgs.symlinkJoin { name = "workload-${run}"; paths = [ ripgrep jq ]; };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell { packages = with pkgs; [ nodejs_24 gh jq ]; };
      });
    };
}
