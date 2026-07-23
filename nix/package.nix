{
  lib,
  stdenvNoCC,
  bun,
  duckdb,
  makeWrapper,
}:

stdenvNoCC.mkDerivation {
  pname = "chatlog";
  version = "0.1.0";

  # Only the runtime-relevant tree. Corpus, derived artifacts, and the
  # analysis database are gitignored and untracked, so they are already
  # absent here; this list is the explicit belt to those gitignore braces.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../package.json
      ../tsconfig.json
    ];
  };

  nativeBuildInputs = [ makeWrapper ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/chatlog"
    cp -r src package.json tsconfig.json "$out/share/chatlog/"

    mkdir -p "$out/bin"

    makeWrapper ${lib.getExe bun} "$out/bin/chatlog" \
      --chdir "$out/share/chatlog" \
      --prefix PATH : ${lib.makeBinPath [ duckdb ]} \
      --add-flags "run $out/share/chatlog/src/cli.ts"

    makeWrapper ${lib.getExe bun} "$out/bin/chatlog-workbench" \
      --chdir "$out/share/chatlog" \
      --add-flags "run $out/share/chatlog/src/workbench/server.ts"

    makeWrapper ${lib.getExe bun} "$out/bin/chatlog-mcp" \
      --chdir "$out/share/chatlog" \
      --add-flags "run $out/share/chatlog/src/mcp/server.ts"

    runHook postInstall
  '';

  meta = {
    description = "Chatlog CLI, Workbench, and MCP server: local, redacted conversation recall";
    mainProgram = "chatlog-workbench";
    platforms = lib.platforms.unix;
  };
}
