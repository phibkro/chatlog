{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.chatlog-workbench;
  isExactHttpOrigin =
    origin:
    let
      match = builtins.match "https?://(([A-Za-z0-9.-]+)|([[][0-9A-Fa-f:.]+[]]))(:([0-9]+))?" origin;
      portText = if match == null then null else builtins.elemAt match 4;
      port = if portText == null then null else lib.toInt portText;
    in
    match != null && (port == null || (port >= 1 && port <= 65535));
in
{
  options.services.chatlog-workbench = {
    enable = lib.mkEnableOption "the Chatlog Workbench user service (disabled by default)";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage <chatlog>/nix/package.nix { }";
      description = ''
        Chatlog package providing the `chatlog`, `chatlog-workbench`, and
        `chatlog-mcp` entry points.
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

    allowAnnotations = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Enable the narrowly scoped browser endpoint for append-only workflow
        pattern annotations. This does not enable source, evidence, derived
        claim, or harness mutation. Keep the service loopback-only and declare
        any reverse-proxy origin with annotationOrigins.
      '';
    };

    annotationOrigins = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "https://chatlog.example.net" ];
      description = ''
        Exact external browser origins allowed to write annotations. Loopback
        origins for the configured port are built into the server. Forwarded
        headers are never used as annotation authority.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = builtins.elem cfg.host [
          "127.0.0.1"
          "::1"
          "localhost"
        ];
        message = ''
          services.chatlog-workbench.host must remain loopback-only. Keep
          127.0.0.1 and use Tailscale Serve or another authenticated reverse
          proxy for remote access.
        '';
      }
      {
        assertion = builtins.all isExactHttpOrigin cfg.annotationOrigins;
        message = ''
          Every services.chatlog-workbench.annotationOrigins entry must be an
          HTTP(S) origin with a valid host/port and no credentials, path,
          query, or fragment.
        '';
      }
    ];

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
          "CHATLOG_ALLOW_ANNOTATIONS=${if cfg.allowAnnotations then "1" else "0"}"
          "CHATLOG_ANNOTATION_ORIGINS=${lib.concatStringsSep "," cfg.annotationOrigins}"
        ];
        Restart = "on-failure";
        RestartSec = 5;

        # Conservative hardening for a loopback-bound local service. The data
        # root is writable for an explicitly enabled append-only annotation
        # layer. MemoryDenyWriteExecute is deliberately omitted: Bun JITs.
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
