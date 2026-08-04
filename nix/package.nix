{
  lib,
  bun,
  bun2nix,
  duckdb,
  makeWrapper,
}:

bun2nix.mkDerivation {
  pname = "chatlog";
  version = "0.1.0-rc.1";

  # Keep the runtime tree, lock inputs, workspace manifest, and provider
  # plugin together so the installed artifact is independent of a checkout.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../plugins/chatlog-memory
      ../.claude-plugin/marketplace.json
      ../.agents/plugins/marketplace.json
      ../apps/workbench-web/package.json
      ../package.json
      ../bun.lock
      ../bun.nix
      ../tsconfig.json
    ];
  };

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../bun.nix;
  };

  bunInstallFlags = [
    "--linker=hoisted"
    "--production"
    "--frozen-lockfile"
  ];
  dontRunLifecycleScripts = true;
  dontUseBunBuild = true;
  dontUseBunCheck = true;
  dontUseBunInstall = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/chatlog"
    cp -rL src package.json bun.lock tsconfig.json node_modules "$out/share/chatlog/"
    cp -rL plugins/chatlog-memory "$out/share/chatlog/plugin"
    substituteInPlace "$out/share/chatlog/plugin/hooks/hooks.json" \
      --replace-fail '"command": "bun ' '"command": "${lib.getExe bun} --no-install '
    for manifest in \
      "$out/share/chatlog/plugin/.mcp.json" \
      "$out/share/chatlog/plugin/codex.mcp.json" \
      "$out/share/chatlog/plugin/.codex-plugin/plugin.json"
    do
      substituteInPlace "$manifest" \
        --replace-fail '"command": "bun"' '"command": "${lib.getExe bun}"' \
        --replace-fail '"args": [' '"args": ["--no-install", '
    done
    mkdir -p \
      "$out/share/chatlog/marketplace/.claude-plugin" \
      "$out/share/chatlog/marketplace/.agents/plugins" \
      "$out/share/chatlog/marketplace/plugins"
    cp .claude-plugin/marketplace.json \
      "$out/share/chatlog/marketplace/.claude-plugin/marketplace.json"
    cp .agents/plugins/marketplace.json \
      "$out/share/chatlog/marketplace/.agents/plugins/marketplace.json"
    cp -rL "$out/share/chatlog/plugin" \
      "$out/share/chatlog/marketplace/plugins/chatlog-memory"
    test -f "$out/share/chatlog/src/workbench/public/memory/index.html"
    test -f "$out/share/chatlog/src/workbench/public/memory/assets/app.js"
    test -f "$out/share/chatlog/src/workbench/public/memory/assets/index.css"

    mkdir -p "$out/bin"

    makeWrapper ${lib.getExe bun} "$out/bin/chatlog" \
      --chdir "$out/share/chatlog" \
      --prefix PATH : ${lib.makeBinPath [ duckdb ]} \
      --add-flags "--no-install run $out/share/chatlog/src/cli.ts"

    makeWrapper ${lib.getExe bun} "$out/bin/chatlog-workbench" \
      --chdir "$out/share/chatlog" \
      --add-flags "--no-install run $out/share/chatlog/src/workbench/server.ts"

    makeWrapper ${lib.getExe bun} "$out/bin/chatlog-mcp" \
      --chdir "$out/share/chatlog" \
      --add-flags "--no-install run $out/share/chatlog/src/mcp/server.ts"

    runHook postInstall
  '';

  meta = {
    description = "Chatlog CLI, Workbench, and MCP server: local, redacted conversation recall";
    mainProgram = "chatlog-workbench";
    platforms = lib.platforms.unix;
  };
}
