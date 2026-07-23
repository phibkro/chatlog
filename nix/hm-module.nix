{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.chatlog-workbench;
in
{
  options.services.chatlog-workbench = {
    enable = lib.mkEnableOption "the Chatlog Workbench user service (disabled by default)";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage <chatlog>/nix/package.nix { }";
      description = ''
        Chatlog package providing the `chatlog-workbench` and `chatlog-mcp`
        entry points.
      '';
    };

    dataRoot = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.dataHome}/chatlog";
      defaultText = lib.literalExpression ''"''${config.xdg.dataHome}/chatlog"'';
      description = ''
        Directory holding the corpus, derived artifacts, and analysis
        database. Created on activation if missing. Never populated from the
        Nix store.
      '';
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Listen address. The server itself refuses to bind a non-loopback
        address unless `CHATLOG_ALLOW_REMOTE=1` is set in its environment,
        so changing this option alone will not expose the service; prefer
        Tailscale Serve or another authenticated reverse proxy for remote
        access instead of widening the bind address.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4789;
      description = "Listen port.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.activation.chatlogWorkbenchDataRoot = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run mkdir -p ${lib.escapeShellArg cfg.dataRoot}
    '';

    systemd.user.services.chatlog-workbench = {
      Unit = {
        Description = "Chatlog Workbench";
        After = [ "default.target" ];
      };

      Service = {
        Type = "simple";
        ExecStart = lib.getExe' cfg.package "chatlog-workbench";
        Environment = [
          "CHATLOG_DATA_ROOT=${cfg.dataRoot}"
          "CHATLOG_HOST=${cfg.host}"
          "CHATLOG_PORT=${toString cfg.port}"
        ];
        Restart = "on-failure";
        RestartSec = 5;

        # Conservative hardening for a loopback-bound, read-only local
        # service. MemoryDenyWriteExecute is deliberately omitted: Bun JITs.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        ReadWritePaths = [ cfg.dataRoot ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        LockPersonality = true;
        RemoveIPC = true;
      };

      Install.WantedBy = [ "default.target" ];
    };
  };
}
