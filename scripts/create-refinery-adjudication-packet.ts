import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildAdjudicationPacket } from "../src/refinery-adjudication";
import { loadRefinery } from "../src/refinery";

const ROOT = process.env.CHATLOG_DATA_ROOT ?? process.cwd();
const requested = Number(process.env.ADJUDICATION_COUNT ?? 30);
const seed = process.env.ADJUDICATION_SEED ?? "refinery-human-gold-v1";

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  if (await Bun.file(path).exists()) {
    const existing = await Bun.file(path).text();
    if (existing !== text)
      throw new Error(`refusing to overwrite non-identical adjudication artifact: ${path}`);
    await chmod(path, 0o600);
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function main(): Promise<void> {
  const artifact = await loadRefinery(ROOT);
  const built = buildAdjudicationPacket(artifact, requested, seed);
  if (!built.ok) throw new Error(`${built.error.code}: ${built.error.message}`);

  const packetRoot = join(ROOT, "derived", "adjudication", "refinery", built.packet.packetHash);
  const outputDirectory = join(packetRoot, "public");
  const privateDirectory = join(
    ROOT,
    "derived",
    "adjudication",
    "refinery-private",
    built.packet.packetHash,
  );
  const packetPath = join(outputDirectory, "packet.json");
  const markdownPath = join(outputDirectory, "packet.md");
  const answersPath = join(outputDirectory, "answers.template.json");
  const schemaPath = join(outputDirectory, "answers.schema.json");
  const privateManifestPath = join(privateDirectory, "manifest.json");
  await atomicWrite(packetPath, `${JSON.stringify(built.packet, null, 2)}\n`);
  await atomicWrite(markdownPath, built.markdown);
  await atomicWrite(answersPath, `${JSON.stringify(built.answers, null, 2)}\n`);
  await atomicWrite(schemaPath, `${JSON.stringify(built.answerSchema, null, 2)}\n`);
  await atomicWrite(privateManifestPath, `${JSON.stringify(built.privateManifest, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        packetHash: built.packet.packetHash,
        candidates: built.packet.candidates.length,
        packetPath,
        markdownPath,
        answersPath,
        schemaPath,
        privateManifestPath,
      },
      null,
      2,
    ),
  );
}

await main();
