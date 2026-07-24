import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPatternAnnotationHistory,
  loadPatternAnnotationView,
  patternArtifactSnapshot,
  patternHandle,
  PatternAnnotationConflictError,
  PatternAnnotationIntegrityError,
  writePatternAnnotation,
} from "../src/pattern-annotations";
import type {
  WorkflowPattern,
  WorkflowPatternsArtifact,
} from "../src/workflow-patterns";

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function workflowPattern(id = "internal-pattern-id"): WorkflowPattern {
  return {
    id,
    kind: "ownership-boundary",
    signal: "one-writer",
    role: "worker",
    title: "Worker agents: keep one writer",
    claim: "Repeated across three distinct episodes.",
    boundaryEffect: "guardrail-imposed",
    coverage: {
      eventMemberships: 3,
      sharedEventMemberships: 0,
      distinctEpisodes: 3,
      distinctDays: 3,
      distinctFormulations: 2,
      collapsedSameEpisodeMemberships: 0,
      projects: ["/private/project"],
      harnesses: ["codex"],
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-03T00:00:00.000Z",
      minimumDistinctEpisodes: 3,
      minimumDistinctDays: 2,
    },
    sequence: {
      relations: {
        introduced: 1,
        reinforced: 1,
        reformulated: 1,
        "returned-to-prior": 0,
      },
      latestRelation: "reformulated",
      timeline: [],
    },
    outcomes: {
      status: "insufficient-coverage",
      observedEpisodes: 0,
      sparseEpisodes: 3,
      minimumObservedEpisodes: 3,
      reasons: ["observed-episodes-below-3"],
      metrics: {
        completionRate: {
          orientation: "higher-is-favorable",
          samples: 0,
          favorable: null,
          unfavorable: null,
          unchanged: null,
          medianDelta: null,
        },
        frictionRate: {
          orientation: "lower-is-favorable",
          samples: 0,
          favorable: null,
          unfavorable: null,
          unchanged: null,
          medianDelta: null,
        },
        reworkRate: {
          orientation: "lower-is-favorable",
          samples: 0,
          favorable: null,
          unfavorable: null,
          unchanged: null,
          medianDelta: null,
        },
      },
      interpretation: {
        claim: "Coverage remains sparse.",
        causal: false,
      },
    },
    examples: [],
  };
}

function artifact(
  patterns: WorkflowPattern[] = [workflowPattern()],
): WorkflowPatternsArtifact {
  return {
    schema: "chatlog/workflow-patterns-v1",
    schemaVersion: 1,
    outputKind: "workflow-patterns",
    inputProjectionHash: sha256("input"),
    structureProjectionHash: sha256("structure"),
    workflowContentHash: sha256("workflow"),
    outcomesContentHash: sha256("outcomes"),
    methodology: {
      identity: "",
      repetition: "",
      relations: "",
      boundaryEffect: "",
      outcomes: "",
      causality: "",
    },
    summary: {
      workflowEvents: 3,
      candidateSignatures: patterns.length,
      repeatedPatterns: patterns.length,
      belowFloorSignatures: 0,
      outcomeObservedPatterns: 0,
      minimumDistinctEpisodes: 3,
      minimumDistinctDays: 2,
      byKind: {
        "approval-gate-changed": 0,
        "autonomy-boundary": 0,
        "ownership-boundary": patterns.length,
      },
    },
    patterns,
    egress: { performed: false, surface: "none", hostedCalls: 0 },
  };
}

function writeInput(
  pattern: WorkflowPattern,
  artifactHash: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    handle: patternHandle(pattern),
    expectedRevision: 0,
    observedSnapshot: patternArtifactSnapshot(artifactHash),
    disposition: "confirmed" as const,
    label: "One writer",
    note: "Applies when agents share mutable state.",
    ...overrides,
  };
}

test("pattern handles and artifact snapshots are stable public concurrency tokens", () => {
  const first = workflowPattern("first-internal-id");
  const second = workflowPattern("second-internal-id");
  expect(patternHandle(first)).toBe(patternHandle(second));
  expect(patternHandle(first)).toMatch(/^[a-f0-9]{24}$/);
  expect(patternArtifactSnapshot(sha256("artifact")))
    .toMatch(/^[a-f0-9]{24}$/);
  expect(patternArtifactSnapshot(sha256("artifact")))
    .not.toBe(patternArtifactSnapshot(sha256("other-artifact")));
});

test("annotation writes retain private immutable history across reloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-annotations-"));
  const patterns = artifact();
  const pattern = patterns.patterns[0];
  const artifactHash = sha256("artifact");
  const handle = patternHandle(pattern);

  expect(await loadPatternAnnotationView(
    root,
    patterns,
    artifactHash,
    true,
  )).toMatchObject({
    enabled: true,
    summary: { activeAnnotated: 0, inactivePatternAnnotations: 0 },
    annotations: {},
  });
  const first = await writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T10:00:00.000Z",
    },
  );
  expect(first).toEqual({
    disposition: "confirmed",
    label: "One writer",
    note: "Applies when agents share mutable state.",
    revision: 1,
    updatedAt: "2026-07-24T10:00:00.000Z",
  });
  const second = await writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, {
      expectedRevision: 1,
      disposition: "contextual",
      label: "Single mutable writer",
      note: "Context only.",
    }),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T11:00:00.000Z",
    },
  );
  expect(second).toMatchObject({ disposition: "contextual", revision: 2 });
  expect(await loadPatternAnnotationHistory(root, handle)).toEqual([
    second,
    first,
  ]);
  const reloaded = await loadPatternAnnotationView(
    root,
    patterns,
    artifactHash,
    false,
  );
  expect(reloaded).toMatchObject({
    enabled: false,
    summary: { activeAnnotated: 1, contextual: 1 },
    annotations: {
      [handle]: {
        disposition: "contextual",
        revision: 2,
      },
    },
  });
  const manifest = join(
    root,
    "annotations",
    "workflow-patterns-manifest.json",
  );
  expect((await stat(manifest)).mode & 0o777).toBe(0o600);
  expect((await stat(join(
    root,
    "annotations",
    "workflow-patterns-lock.sqlite",
  ))).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "annotations", "objects"))).mode & 0o777)
    .toBe(0o700);
  expect(JSON.stringify(reloaded)).not.toContain(artifactHash);
  expect(JSON.stringify(reloaded)).not.toContain("/private/project");
  expect(JSON.stringify(reloaded)).not.toContain("contentHash");
});

test("stale revisions, stale snapshots, and inactive handles fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-annotation-conflict-"));
  const patterns = artifact();
  const pattern = patterns.patterns[0];
  const artifactHash = sha256("artifact");
  await writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T10:00:00.000Z",
    },
  );
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T11:00:00.000Z",
    },
  )).rejects.toBeInstanceOf(PatternAnnotationConflictError);
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, {
      expectedRevision: 1,
      observedSnapshot: patternArtifactSnapshot(sha256("stale-artifact")),
    }),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T11:00:00.000Z",
    },
  )).rejects.toBeInstanceOf(PatternAnnotationConflictError);
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, {
      expectedRevision: 1,
      handle: "f".repeat(24),
    }),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T11:00:00.000Z",
    },
  )).rejects.toThrow("not currently active");
  expect((await loadPatternAnnotationHistory(root, patternHandle(pattern))))
    .toHaveLength(1);
});

test("concurrent annotation writes serialize and preserve one winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-annotation-race-"));
  const patterns = artifact();
  const pattern = patterns.patterns[0];
  const artifactHash = sha256("artifact");
  const writes = await Promise.allSettled([
    writePatternAnnotation(
      root,
      writeInput(pattern, artifactHash, { note: "first" }),
      {
        artifact: patterns,
        artifactContentHash: artifactHash,
        now: "2026-07-24T10:00:00.000Z",
      },
    ),
    writePatternAnnotation(
      root,
      writeInput(pattern, artifactHash, { note: "second" }),
      {
        artifact: patterns,
        artifactContentHash: artifactHash,
        now: "2026-07-24T10:00:01.000Z",
      },
    ),
  ]);
  expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect((await loadPatternAnnotationHistory(root, patternHandle(pattern))))
    .toHaveLength(1);
});

test("concurrent annotations for distinct patterns retain both updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-annotation-distinct-race-"));
  const first = workflowPattern("first");
  const second: WorkflowPattern = {
    ...workflowPattern("second"),
    kind: "autonomy-boundary",
    signal: "self-propel",
    role: "manager",
    title: "Managers: continue autonomously",
  };
  const patterns = artifact([first, second]);
  const artifactHash = sha256("artifact");
  await expect(Promise.all([
    writePatternAnnotation(
      root,
      writeInput(first, artifactHash, { note: "first" }),
      { artifact: patterns, artifactContentHash: artifactHash },
    ),
    writePatternAnnotation(
      root,
      writeInput(second, artifactHash, { note: "second" }),
      { artifact: patterns, artifactContentHash: artifactHash },
    ),
  ])).resolves.toHaveLength(2);
  const view = await loadPatternAnnotationView(
    root,
    patterns,
    artifactHash,
    true,
  );
  expect(view.summary.activeAnnotated).toBe(2);
  expect(Object.keys(view.annotations).sort()).toEqual([
    patternHandle(first),
    patternHandle(second),
  ].sort());
});

test("annotation locking waits without blocking and recovers after holder exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-annotation-lock-"));
  const directory = join(root, "annotations");
  const path = join(directory, "workflow-patterns-lock.sqlite");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, "", { mode: 0o600 });
  const blocker = new Database(path);
  blocker.exec("BEGIN IMMEDIATE");
  const release = setTimeout(() => {
    blocker.exec("ROLLBACK");
    blocker.close();
  }, 25);
  const patterns = artifact();
  const artifactHash = sha256("artifact");
  await expect(writePatternAnnotation(
    root,
    writeInput(patterns.patterns[0], artifactHash),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).resolves.toMatchObject({ revision: 1 });
  clearTimeout(release);
});

test("annotation locking recovers after a separate holder process is killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-annotation-killed-lock-"));
  const directory = join(root, "annotations");
  const path = join(directory, "workflow-patterns-lock.sqlite");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, "", { mode: 0o600 });
  const holder = Bun.spawn([
    process.execPath,
    "-e",
    `
      import { Database } from "bun:sqlite";
      const database = new Database(process.env.CHATLOG_TEST_LOCK_PATH);
      database.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      await new Promise(() => {});
    `,
  ], {
    env: {
      ...process.env,
      CHATLOG_TEST_LOCK_PATH: path,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = holder.stdout.getReader();
  const firstOutput = await reader.read();
  reader.releaseLock();
  expect(new TextDecoder().decode(firstOutput.value)).toContain("locked");
  holder.kill("SIGKILL");
  await holder.exited;

  const patterns = artifact();
  const artifactHash = sha256("artifact");
  await expect(writePatternAnnotation(
    root,
    writeInput(patterns.patterns[0], artifactHash),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).resolves.toMatchObject({ revision: 1 });
});

test("crashes after object creation leave the prior manifest authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-annotation-crash-"));
  const patterns = artifact();
  const pattern = patterns.patterns[0];
  const artifactHash = sha256("artifact");
  const handle = patternHandle(pattern);
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T10:00:00.000Z",
      afterObjectWrite: () => {
        throw new Error("simulated first-write crash");
      },
    },
  )).rejects.toThrow("simulated first-write crash");
  expect(await loadPatternAnnotationHistory(root, handle)).toEqual([]);

  const first = await writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T10:01:00.000Z",
    },
  );
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, {
      expectedRevision: 1,
      disposition: "dismissed",
    }),
    {
      artifact: patterns,
      artifactContentHash: artifactHash,
      now: "2026-07-24T10:02:00.000Z",
      afterObjectWrite: () => {
        throw new Error("simulated update crash");
      },
    },
  )).rejects.toThrow("simulated update crash");
  expect(await loadPatternAnnotationHistory(root, handle)).toEqual([first]);
});

test("manifest, record, missing-authority, and predecessor tampering fail closed", async () => {
  const setup = async (label: string) => {
    const root = await mkdtemp(join(tmpdir(), `chatlog-annotation-${label}-`));
    const patterns = artifact();
    const pattern = patterns.patterns[0];
    const artifactHash = sha256("artifact");
    await writePatternAnnotation(
      root,
      writeInput(pattern, artifactHash),
      {
        artifact: patterns,
        artifactContentHash: artifactHash,
        now: "2026-07-24T10:00:00.000Z",
      },
    );
    return { root, patterns, pattern, artifactHash };
  };

  const manifestTamper = await setup("manifest-tamper");
  const manifestPath = join(
    manifestTamper.root,
    "annotations",
    "workflow-patterns-manifest.json",
  );
  const modifiedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  modifiedManifest.revision = 99;
  await writeFile(manifestPath, JSON.stringify(modifiedManifest));
  await expect(loadPatternAnnotationView(
    manifestTamper.root,
    manifestTamper.patterns,
    manifestTamper.artifactHash,
    true,
  )).rejects.toBeInstanceOf(PatternAnnotationIntegrityError);

  const recordTamper = await setup("record-tamper");
  const recordManifest = JSON.parse(await readFile(
    join(
      recordTamper.root,
      "annotations",
      "workflow-patterns-manifest.json",
    ),
    "utf8",
  ));
  const recordHash = Object.values(recordManifest.current)[0] as string;
  const recordPath = join(
    recordTamper.root,
    "annotations",
    "objects",
    recordHash.slice(0, 2),
    `${recordHash}.json`,
  );
  const modifiedRecord = JSON.parse(await readFile(recordPath, "utf8"));
  modifiedRecord.note = "tampered";
  await writeFile(recordPath, JSON.stringify(modifiedRecord));
  await expect(loadPatternAnnotationHistory(
    recordTamper.root,
    patternHandle(recordTamper.pattern),
  )).rejects.toBeInstanceOf(PatternAnnotationIntegrityError);

  const missingManifest = await setup("missing-manifest");
  await unlink(join(
    missingManifest.root,
    "annotations",
    "workflow-patterns-manifest.json",
  ));
  await expect(loadPatternAnnotationView(
    missingManifest.root,
    missingManifest.patterns,
    missingManifest.artifactHash,
    true,
  )).rejects.toThrow("manifest is missing");

  const predecessorTamper = await setup("predecessor");
  await writePatternAnnotation(
    predecessorTamper.root,
    writeInput(
      predecessorTamper.pattern,
      predecessorTamper.artifactHash,
      { expectedRevision: 1, disposition: "contextual" },
    ),
    {
      artifact: predecessorTamper.patterns,
      artifactContentHash: predecessorTamper.artifactHash,
      now: "2026-07-24T11:00:00.000Z",
    },
  );
  const predecessorManifestPath = join(
    predecessorTamper.root,
    "annotations",
    "workflow-patterns-manifest.json",
  );
  const predecessorManifest = JSON.parse(
    await readFile(predecessorManifestPath, "utf8"),
  );
  const currentHash = Object.values(predecessorManifest.current)[0] as string;
  const currentPath = join(
    predecessorTamper.root,
    "annotations",
    "objects",
    currentHash.slice(0, 2),
    `${currentHash}.json`,
  );
  const currentRecord = JSON.parse(await readFile(currentPath, "utf8"));
  const priorPath = join(
    predecessorTamper.root,
    "annotations",
    "objects",
    currentRecord.previousContentHash.slice(0, 2),
    `${currentRecord.previousContentHash}.json`,
  );
  const fakePrior = JSON.parse(await readFile(priorPath, "utf8"));
  delete fakePrior.contentHash;
  fakePrior.revision = 7;
  const fakePriorHash = sha256(JSON.stringify(fakePrior));
  await mkdir(join(
    predecessorTamper.root,
    "annotations",
    "objects",
    fakePriorHash.slice(0, 2),
  ), { recursive: true });
  await writeFile(
    join(
      predecessorTamper.root,
      "annotations",
      "objects",
      fakePriorHash.slice(0, 2),
      `${fakePriorHash}.json`,
    ),
    JSON.stringify({ ...fakePrior, contentHash: fakePriorHash }),
  );
  delete currentRecord.contentHash;
  currentRecord.previousContentHash = fakePriorHash;
  const fakeCurrentHash = sha256(JSON.stringify(currentRecord));
  await mkdir(join(
    predecessorTamper.root,
    "annotations",
    "objects",
    fakeCurrentHash.slice(0, 2),
  ), { recursive: true });
  await writeFile(
    join(
      predecessorTamper.root,
      "annotations",
      "objects",
      fakeCurrentHash.slice(0, 2),
      `${fakeCurrentHash}.json`,
    ),
    JSON.stringify({ ...currentRecord, contentHash: fakeCurrentHash }),
  );
  delete predecessorManifest.integrityHash;
  predecessorManifest.current[patternHandle(predecessorTamper.pattern)] =
    fakeCurrentHash;
  const integrityHash = sha256(JSON.stringify(predecessorManifest));
  await writeFile(
    predecessorManifestPath,
    JSON.stringify({ ...predecessorManifest, integrityHash }),
  );
  await expect(loadPatternAnnotationHistory(
    predecessorTamper.root,
    patternHandle(predecessorTamper.pattern),
  )).rejects.toThrow("predecessor");
});

test("annotation text is bounded and rejects unsupported control characters", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-annotation-bounds-"));
  const patterns = artifact();
  const pattern = patterns.patterns[0];
  const artifactHash = sha256("artifact");
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, { label: "x".repeat(121) }),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).rejects.toThrow("annotation label exceeds");
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, { note: `bad\u0000note` }),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).rejects.toThrow("control characters");
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, { note: `bad\u0085note` }),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).rejects.toThrow("control characters");
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, { label: `trusted\u202Eevil` }),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).rejects.toThrow("control characters");
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, { label: `trusted\u061Cevil` }),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).rejects.toThrow("control characters");
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, { label: `two\u2028lines` }),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).rejects.toThrow("control characters");
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, { label: `two\u2029paragraphs` }),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).rejects.toThrow("control characters");
  await expect(writePatternAnnotation(
    root,
    writeInput(pattern, artifactHash, { label: "two\nlines" }),
    { artifact: patterns, artifactContentHash: artifactHash },
  )).rejects.toThrow("single line");
});
