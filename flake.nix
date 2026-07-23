{
  description = "Chatlog: local, redacted coding-session corpus, Workbench, and MCP server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      home-manager,
    }:
    let
      # Chatlog's persistent service and corpus currently live on NixOS.
      # The Mac reaches Workbench through Tailscale rather than hosting it.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        system: pkgs: {
          chatlog = pkgs.callPackage ./nix/package.nix { };
          default = self.packages.${system}.chatlog;
        }
      );

      apps = forAllSystems (
        system: pkgs: {
          workbench = {
            type = "app";
            program = "${self.packages.${system}.chatlog}/bin/chatlog-workbench";
            meta.description = "Run the local Chatlog Workbench";
          };
          mcp = {
            type = "app";
            program = "${self.packages.${system}.chatlog}/bin/chatlog-mcp";
            meta.description = "Run the policy-bounded Chatlog MCP stdio server";
          };
          default = self.apps.${system}.workbench;
        }
      );

      homeManagerModules = {
        chatlog-workbench = import ./nix/hm-module.nix;
        default = self.homeManagerModules.chatlog-workbench;
      };

      checks = forAllSystems (
        system: pkgs:
        {
          chatlog = self.packages.${system}.chatlog;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
          import ./nix/checks/module-eval.nix {
            inherit pkgs;
            inherit (home-manager.lib) homeManagerConfiguration;
            hmModule = self.homeManagerModules.default;
          }
        )
      );
    };
}
