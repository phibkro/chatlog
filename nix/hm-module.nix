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

    /*
      Nomination is the half that should NOT wait on the operator. `refine`
      only ever produces a review queue — promotion stays manual by design
      (docs/knowledge-refinery.md: "It does not turn repetition into truth"),
      so a timer adds candidates to inspect, never accepted knowledge.

      Without it, a broken pipeline and an un-run one look identical: a Codex
      schema addition halted ingestion on 2026-07-23 and went unnoticed until
      2026-07-27, because nothing ran it and nothing reported that.
    */
    refresh = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Periodically run ingest -> derive -> refine.";
      };

      onCalendar = lib.mkOption {
        type = lib.types.str;
        default = "hourly";
        example = "*-*-* 03:00:00";
        description = ''
          systemd calendar expression. The run is idempotent: an unchanged
          corpus re-derives to the same hashes and `refine` returns
          `processed: false`.
        '';
      };

      onFailure = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "user-notify@chatlog-refresh.service" ];
        description = ''
          Units to trigger when a refresh fails. Empty by default to keep this
          module portable — alerting policy belongs to the host configuration
          that knows which notification construct exists. Hosts that have an
          alert path should set this: a silent refresh failure is precisely how
          this pipeline rotted for five days.
        '';
      };
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

    systemd.user.services.chatlog-refresh = lib.mkIf cfg.refresh.enable {
      Unit = {
        Description = "Chatlog corpus refresh (ingest, derive, refine)";
        OnFailure = cfg.refresh.onFailure;
      };

      Service = {
        Type = "oneshot";
        # Sequential and fail-fast: derive reads what ingest wrote and refine
        # reads what derive wrote, so a partial run must not advance the later
        # stages over stale input.
        ExecStart = [
          "${lib.getExe' cfg.package "chatlog"} ingest"
          "${lib.getExe' cfg.package "chatlog"} derive"
          "${lib.getExe' cfg.package "chatlog"} refine"
        ];
        Environment = [ "CHATLOG_DATA_ROOT=${cfg.dataRoot}" ];

        # ProtectHome=read-only is load-bearing rather than incidental:
        # ingestion's whole contract is that it reads ~/.claude, ~/.codex and
        # ~/.pi and never writes beneath them. The sandbox enforces the README.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        ReadWritePaths = [ cfg.dataRoot ];
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        RestrictAddressFamilies = [ "AF_UNIX" ];
        RestrictNamespaces = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        LockPersonality = true;
        RemoveIPC = true;

        # The run is incremental, so outliving its interval is a defect rather
        # than a long job. Bounded so a wedged stage cannot stack up.
        TimeoutStartSec = "30min";
        # Loses the race against the operator's agent fleet on purpose:
        # candidates can wait, interactive work cannot.
        Nice = 15;
        IOSchedulingClass = "idle";
      };
    };

    systemd.user.timers.chatlog-refresh = lib.mkIf cfg.refresh.enable {
      Unit.Description = "Periodic chatlog corpus refresh";
      Timer = {
        OnCalendar = cfg.refresh.onCalendar;
        # Persistent so a sleep-friendly workstation catches up on wake rather
        # than silently skipping every trigger it slept through.
        Persistent = true;
        RandomizedDelaySec = "5min";
      };
      Install.WantedBy = [ "timers.target" ];
    };
  };
}
