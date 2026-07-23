{
  pkgs,
  homeManagerConfiguration,
  hmModule,
}:

let
  lib = pkgs.lib;

  baseModule = {
    home.username = "chatlog-test";
    home.homeDirectory = "/home/chatlog-test";
    home.stateVersion = "24.11";
    # Evaluation-only stub; the real journey (activation, systemd) is left
    # to the operator's own home-manager switch.
    targets.genericLinux.enable = true;
  };

  build =
    extraModule:
    homeManagerConfiguration {
      inherit pkgs;
      modules = [
        hmModule
        baseModule
        extraModule
      ];
    };

  disabled = build { };
  enabled = build { services.chatlog-workbench.enable = true; };
  invalidRemoteEvaluation = builtins.tryEval (
    (build {
      services.chatlog-workbench = {
        enable = true;
        host = "100.64.0.7";
      };
    }).activationPackage.drvPath
  );

  disabledServices = disabled.config.systemd.user.services;
  enabledService = enabled.config.systemd.user.services.chatlog-workbench;
  env = enabledService.Service.Environment;

  hasLoopbackHost = builtins.elem "CHATLOG_HOST=127.0.0.1" env;
  hasDataRoot = lib.any (line: lib.hasPrefix "CHATLOG_DATA_ROOT=" line) env;
  isInstalled = (enabledService.Install.WantedBy or [ ]) != [ ];
  rejectsRemoteHost = !invalidRemoteEvaluation.success;
in
assert lib.assertMsg (!(disabledServices ? chatlog-workbench))
  "chatlog-workbench must not be defined in systemd.user.services when services.chatlog-workbench.enable = false";
assert lib.assertMsg hasLoopbackHost
  "chatlog-workbench must default CHATLOG_HOST to 127.0.0.1 when enabled";
assert lib.assertMsg hasDataRoot "chatlog-workbench must set CHATLOG_DATA_ROOT when enabled";
assert lib.assertMsg isInstalled "chatlog-workbench must be installed (WantedBy) when enabled";
assert lib.assertMsg rejectsRemoteHost
  "chatlog-workbench must reject a non-loopback host during module evaluation";
{
  hm-module-eval = pkgs.runCommand "chatlog-hm-module-eval" { } ''
    echo "disabled-by-default, loopback default, and remote-host rejection verified at eval time" > $out
  '';
}
