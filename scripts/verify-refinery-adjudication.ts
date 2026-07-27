import { validateAdjudicationAnswers, type AdjudicationPacket } from "../src/refinery-adjudication";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

async function main(): Promise<void> {
  const [packetPath, answersPath] = Bun.argv.slice(2);
  if (!packetPath || !answersPath)
    throw new Error("usage: bun run adjudication:verify -- <packet.json> <completed-answers.json>");

  const packet = (await readJson(packetPath)) as AdjudicationPacket;
  const answers = await readJson(answersPath);
  const validated = validateAdjudicationAnswers(packet, answers);
  if (!validated.ok) {
    console.error(JSON.stringify({ ok: false, errors: validated.errors }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        packetHash: validated.answers.packetHash,
        adjudicator: validated.answers.adjudicator.id,
        answers: Object.keys(validated.answers.answers).length,
      },
      null,
      2,
    ),
  );
}

await main();
