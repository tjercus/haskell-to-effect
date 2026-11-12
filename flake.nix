{
  description = "haskell-to-effect: a compiler from a Haskell subset to typed TypeScript on Effect";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Node 24 strips TypeScript types natively, which `hs2effect run` and the golden tests rely on.
      nodejsFor = pkgs: pkgs.nodejs_24;
      pnpmFor = pkgs: pkgs.pnpm_12;
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          inherit (pkgs) lib;
          nodejs = nodejsFor pkgs;
          pnpm = pnpmFor pkgs;
        in
        {
          default = self.packages.${pkgs.stdenv.hostPlatform.system}.haskell-to-effect;

          haskell-to-effect = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "haskell-to-effect";
            version = "0.1.0";

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./package.json
                ./pnpm-lock.yaml
                ./pnpm-workspace.yaml
                ./tsconfig.json
                ./vite.config.ts
                ./src
              ];
            };

            nativeBuildInputs = [
              nodejs
              pnpm
              pkgs.pnpmConfigHook
            ];

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 5;
              hash = "sha256-HMen82NbGafl9hLO/ap68U8Vyzl2f+5c3zDk3mJa53s=";
            };

            buildPhase = ''
              runHook preBuild
              node_modules/.bin/vp pack
              runHook postBuild
            '';

            # `hs2effect run` writes the generated program under the package root (so that it
            # can resolve `effect`), but the store is read-only. The wrapper therefore runs the
            # CLI from a writable directory whose `dist` and `node_modules` link into the store.
            installPhase = ''
              runHook preInstall

              # Reinstall only the runtime dependencies (offline, from the fetched store).
              rm -rf node_modules
              pnpm install --offline --prod --frozen-lockfile --ignore-scripts

              lib=$out/lib/haskell-to-effect
              mkdir -p $lib $out/bin
              cp -r dist node_modules package.json $lib/

              cat > $out/bin/hs2effect <<EOF
              #!${pkgs.runtimeShell}
              set -eu
              root="\''${XDG_CACHE_HOME:-\$HOME/.cache}/haskell-to-effect/$(basename $out)"
              if [ ! -e "\$root/package.json" ]; then
                mkdir -p "\$root"
                ln -sfn $lib/dist "\$root/dist"
                ln -sfn $lib/node_modules "\$root/node_modules"
                ln -sfn $lib/package.json "\$root/package.json"
              fi
              exec ${lib.getExe nodejs} --preserve-symlinks-main "\$root/dist/cli.mjs" "\$@"
              EOF
              chmod +x $out/bin/hs2effect
              ln -s hs2effect $out/bin/haskell-to-effect

              runHook postInstall
            '';

            meta = {
              description = "Compile a small subset of Haskell to TypeScript on Effect";
              license = lib.licenses.mit;
              mainProgram = "hs2effect";
            };
          });
        }
      );

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      });

      devShells = forAllSystems (
        pkgs:
        let
          nodejs = nodejsFor pkgs;
          pnpm = pnpmFor pkgs;
        in
        {
          default = pkgs.mkShell {
            packages = [
              nodejs
              pnpm
              pkgs.git
            ];

            # `vp` (Vite+) and `tsc` come from the project's devDependencies.
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
              if [ ! -x node_modules/.bin/vp ]; then
                echo "Run 'pnpm install' to install dependencies (provides vp)."
              fi
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
