/**
 * One sync-latency run. See docs/benchmarks.md for the protocol this implements.
 *
 *   DATABASE_URL=... REDIS_URL=... node --import tsx bench/run.ts --editors 50 --label 50-run1
 *
 * It creates a document with one user per editor, starts the real collab server as a
 * separate production-mode process, starts the load-generator processes, measures,
 * and writes one JSON file. The server and the fixture are removed at the end.
 */
import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signCollabToken } from "@collabdocs/shared";
import { Redis } from "ioredis";
import pg from "pg";
import * as Y from "yjs";
import { nowMs } from "./client";
import { joinLatencies } from "./join";
import { processUsage, provenance, waitForQuiet } from "./machine";
import { measureSkew } from "./skew";
import { summarize } from "./stats";
import { judgeRun } from "./validity";
import type { WorkerConfig, WorkerResult } from "./worker";

const here = path.dirname(fileURLToPath(import.meta.url));
const collabDir = path.resolve(here, "..");
const repoRoot = path.resolve(collabDir, "../..");
export const RESULTS_DIR = "apps/collab/bench/results";

/** The protocol's values. They are the defaults on purpose: a run states what it changed. */
const DEFAULTS = {
  writerShare: 0.2,
  ratePerWriter: 3,
  readerCursorIntervalMs: 5000,
  warmupSeconds: 10,
  durationSeconds: 60,
  drainSeconds: 5,
  editorsPerWorker: 40,
  quietMaxWaitMinutes: 20,
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const num = (name: string, fallback: number) =>
  arg(name) === undefined ? fallback : Number(arg(name));

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const editors = num("editors", NaN);
if (!Number.isInteger(editors) || editors < 2)
  throw new Error("--editors N (at least 2) is required");
const label = arg("label") ?? `${editors}-editors`;
const writerShare = num("writer-share", DEFAULTS.writerShare);
const ratePerWriter = num("rate", DEFAULTS.ratePerWriter);
const warmupSeconds = num("warmup", DEFAULTS.warmupSeconds);
const durationSeconds = num("duration", DEFAULTS.durationSeconds);
const drainSeconds = num("drain", DEFAULTS.drainSeconds);
const editorsPerWorker = num("editors-per-worker", DEFAULTS.editorsPerWorker);
const workerCount = num("workers", Math.ceil(editors / editorsPerWorker));
const readerCursorIntervalMs = num("reader-cursor-interval", DEFAULTS.readerCursorIntervalMs);
const port = num("port", 4400);
const out = arg("out") ?? path.join(RESULTS_DIR, `${label}.json`);
const skipQuietCheck = flag("skip-quiet-check");
/** Every k-th editor writes, so that the writers are spread over the generator processes. */
const isWriter = (i: number) => i % Math.round(1 / writerShare) === 0;

const databaseUrl = need("DATABASE_URL");
const redisUrl = need("REDIS_URL");
const tokenSecret = randomBytes(32).toString("hex");
const redisMessageSecret = randomBytes(32).toString("hex");
const runId = randomBytes(4).toString("hex");
const documentId = `doc_bench_${runId}`;
const userId = (i: number) => `user_bench_${runId}_${i}`;

const children: ChildProcess[] = [];
let tmp = "";
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

/** The versions of the services the server talks to, for the results file. */
async function serviceVersions(): Promise<{ postgres: string; redis: string }> {
  const postgres = (await pool.query<{ server_version: string }>("SHOW server_version")).rows[0]!
    .server_version;
  const redis = new Redis(redisUrl);
  try {
    const info = await redis.info("server");
    return { postgres, redis: /redis_version:(\S+)/.exec(info)?.[1] ?? "unknown" };
  } finally {
    redis.disconnect();
  }
}

async function fixture(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < editors; i += 1) {
      await client.query('INSERT INTO "User" ("id", "email", "name") VALUES ($1, $2, $3)', [
        userId(i),
        `bench-${runId}-${i}@bench.invalid`,
        `Editor ${i}`,
      ]);
    }
    await client.query(
      'INSERT INTO "Document" ("id", "title", "ownerId", "updatedAt") VALUES ($1, $2, $3, now())',
      [documentId, "Load test", userId(0)],
    );
    for (let i = 0; i < editors; i += 1) {
      await client.query(
        'INSERT INTO "Membership" ("id", "documentId", "userId", "role") VALUES ($1, $2, $3, $4::"Role")',
        [`m_bench_${runId}_${i}`, documentId, userId(i), i === 0 ? "owner" : "editor"],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function removeFixture(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM "Document" WHERE "id" = $1', [documentId]);
  await pool.query('DELETE FROM "User" WHERE "id" LIKE $1', [`user_bench_${runId}_%`]);
}

async function storedHash(pool: pg.Pool): Promise<string> {
  const doc = new Y.Doc();
  const snapshots = await pool.query<{ state: Buffer }>(
    'SELECT "state" FROM "DocumentSnapshot" WHERE "documentId" = $1 ORDER BY "version"',
    [documentId],
  );
  for (const row of snapshots.rows) Y.applyUpdate(doc, row.state);
  const updates = await pool.query<{ data: Buffer }>(
    'SELECT "data" FROM "DocumentUpdate" WHERE "documentId" = $1 ORDER BY "seq"',
    [documentId],
  );
  for (const row of updates.rows) Y.applyUpdate(doc, row.data);
  return createHash("sha1").update(doc.getText("text").toString()).digest("hex");
}

function startServer(logFile: string): ChildProcess {
  // The command of `npm run start -w apps/collab` without the wrapper processes, so that
  // the pid that is measured is the server itself. Only what the server needs is passed on:
  // no COLLAB_* variable, so every limit is its default.
  const env = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "production",
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    COLLAB_TOKEN_SECRET: tokenSecret,
    REDIS_MESSAGE_SECRET: redisMessageSecret,
    COLLAB_PORT: String(port),
    COLLAB_HOST: "127.0.0.1",
    COLLAB_INSTANCE_ID: "bench",
  };
  const server = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: collabDir,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr!.pipe(createWriteStream(logFile));
  children.push(server);
  return server;
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error("the collab server did not become healthy");
}

function expectMessage(
  worker: ChildProcess,
  type: string,
): Promise<{ type: string; [k: string]: unknown }> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: { type: string; error?: string }) => {
      if (message.type === "failed") {
        cleanupListeners();
        reject(new Error(`worker failed: ${message.error}`));
      } else if (message.type === type) {
        cleanupListeners();
        resolve(message);
      }
    };
    const onExit = (code: number | null) => {
      cleanupListeners();
      reject(new Error(`worker exited with ${code} while waiting for ${type}`));
    };
    const cleanupListeners = () => {
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
  });
}

const histogramBounds = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
function histogram(latencies: Float64Array): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const bound of histogramBounds) counts[`<=${bound}`] = 0;
  counts[`>${histogramBounds[histogramBounds.length - 1]}`] = 0;
  for (const value of latencies) {
    const bound = histogramBounds.find((b) => value <= b);
    counts[
      bound === undefined ? `>${histogramBounds[histogramBounds.length - 1]}` : `<=${bound}`
    ]! += 1;
  }
  return counts;
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  tmp = mkdtempSync(path.join(os.tmpdir(), "collabdocs-bench-"));

  const quiet = skipQuietCheck
    ? { quiet: false, waitedMs: 0, sample: { idlePercent: NaN, top: [] } }
    : await waitForQuiet(DEFAULTS.quietMaxWaitMinutes * 60_000);
  if (!skipQuietCheck && !quiet.quiet) {
    throw new Error(
      `the machine did not become quiet within ${DEFAULTS.quietMaxWaitMinutes} minutes (idle ${quiet.sample.idlePercent}%)`,
    );
  }
  const where = provenance(repoRoot, RESULTS_DIR);
  const startedAt = new Date().toISOString();

  await fixture(pool);
  const logFile = path.join(tmp, "server.log");
  const server = startServer(logFile);
  const serverExited = new Promise<never>((_, reject) =>
    server.once("exit", (code) => reject(new Error(`the collab server exited with ${code}`))),
  );
  serverExited.catch(() => {});
  await Promise.race([waitHealthy(), serverExited]);
  const serverPid = server.pid!;
  const idleUsage = processUsage(serverPid);

  const usage: Array<{ at: number; rssKiB: number; cpuSeconds: number }> = [];
  const sampler = setInterval(() => {
    try {
      usage.push({ at: nowMs(), ...processUsage(serverPid) });
    } catch {
      // the process is gone; the exit handler reports it
    }
  }, 1000);

  // Tokens are minted now: they live five minutes.
  const tokens: string[] = [];
  for (let i = 0; i < editors; i += 1) {
    const { token } = await signCollabToken({
      documentId,
      userId: userId(i),
      role: i === 0 ? "owner" : "editor",
      secret: tokenSecret,
    });
    tokens.push(token);
  }

  const perWorker = Math.ceil(editors / workerCount);
  const workers: ChildProcess[] = [];
  for (let w = 0; w < workerCount; w += 1) {
    const share = [];
    for (let i = w * perWorker; i < Math.min(editors, (w + 1) * perWorker); i += 1) {
      share.push({ index: i, token: tokens[i]!, writer: isWriter(i) });
    }
    const config: WorkerConfig = {
      workerIndex: w,
      url: `http://127.0.0.1:${port}`,
      documentId,
      editors: share,
      typingIntervalMs: 1000 / ratePerWriter,
      readerCursorIntervalMs,
      outDir: tmp,
      connectBatch: 10,
    };
    const worker = fork(path.join(here, "worker.ts"), [], {
      execArgv: ["--import", "tsx"],
      env: { PATH: process.env.PATH ?? "", BENCH_WORKER: JSON.stringify(config) },
    });
    workers.push(worker);
    children.push(worker);
  }

  await Promise.race([Promise.all(workers.map((w) => expectMessage(w, "ready"))), serverExited]);
  const connectedUsage = processUsage(serverPid);
  // How far apart the clocks of the generator processes are, measured before the run.
  const skews: Array<{ process: number; offsetMs: number; uncertaintyMs: number }> = [];
  for (let w = 0; w < workers.length; w += 1) {
    skews.push({ process: w, ...(await measureSkew(workers[w]!)) });
  }

  const startAt = nowMs() + 500;
  const from = startAt + warmupSeconds * 1000;
  const to = from + durationSeconds * 1000;
  for (const worker of workers) worker.send({ type: "go", from, to });
  await Promise.race([sleep(to + drainSeconds * 1000 - nowMs()), serverExited]);

  const results: WorkerResult[] = [];
  const collected = Promise.all(workers.map((w) => expectMessage(w, "result")));
  for (const worker of workers) worker.send({ type: "collect" });
  for (const message of await collected) results.push(message.result as WorkerResult);
  results.sort((a, b) => a.workerIndex - b.workerIndex);
  clearInterval(sampler);

  // ---- numbers -----------------------------------------------------------------------
  const readRows = (file: string) => {
    const bytes = readFileSync(file);
    return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8);
  };
  const concat = (parts: Float64Array[]) => {
    const all = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    return all;
  };
  const joined = joinLatencies({
    sends: concat(results.map((r) => readRows(r.sendsFile))),
    receives: concat(results.map((r) => readRows(r.receivesFile))),
    receivers: editors,
    window: { from, to },
  });
  if (joined.latencies.length === 0) throw new Error("no latency was observed");
  const latency = summarize(joined.latencies);

  const inWindow = usage.filter((u) => u.at >= from && u.at <= to);
  const first = inWindow[0]!;
  const last = inWindow[inWindow.length - 1]!;
  let peakCpu = 0;
  for (let i = 1; i < inWindow.length; i += 1) {
    const dt = (inWindow[i]!.at - inWindow[i - 1]!.at) / 1000;
    peakCpu = Math.max(
      peakCpu,
      ((inWindow[i]!.cpuSeconds - inWindow[i - 1]!.cpuSeconds) / dt) * 100,
    );
  }
  const serverStats = {
    rssMiB: {
      idleAfterStart: idleUsage.rssKiB / 1024,
      afterConnecting: connectedUsage.rssKiB / 1024,
      windowMax: Math.max(...inWindow.map((u) => u.rssKiB)) / 1024,
      windowEnd: last.rssKiB / 1024,
    },
    cpuPercentOfOneCore: {
      windowMean: ((last.cpuSeconds - first.cpuSeconds) / ((last.at - first.at) / 1000)) * 100,
      windowPeakOneSecond: peakCpu,
    },
    samples: inWindow.length,
  };

  const hashes = results.flatMap((r) => r.finals.map((f) => f.hash));
  const counts = new Map<string, number>();
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  const [commonHash, commonCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  let persistedMismatch = 1;
  for (let i = 0; i < 20; i += 1) {
    if ((await storedHash(pool)) === commonHash) {
      persistedMismatch = 0;
      break;
    }
    await sleep(500);
  }

  const logText = readFileSync(logFile, "utf8");
  const logLines = logText
    .split("\n")
    .filter((line) => line.includes('"level":"warn"') || line.includes('"level":"error"'));

  const verdict = judgeRun({
    latencyP95Ms: latency.p95,
    generatorLagP99Ms: results.map((r) => r.lag.p99),
    disconnects: results.reduce((n, r) => n + r.disconnects, 0),
    rejections: results.reduce((n, r) => n + r.rejections, 0),
    connectErrors: results.reduce((n, r) => n + r.connectErrors.length, 0),
    serverWarnings: logLines.length,
    missing: joined.missing,
    duplicates: joined.duplicates,
    unmatched: joined.unmatched,
    negative: joined.negative,
    diverged: editors - commonCount,
    persistedMismatch,
    machineQuiet: skipQuietCheck ? false : quiet.quiet,
  });

  const messages = results.reduce(
    (n, r) => ({ sync: n.sync + r.messages.sync, awareness: n.awareness + r.messages.awareness }),
    { sync: 0, awareness: 0 },
  );
  const seconds = durationSeconds;
  let writerCount = 0;
  for (let i = 0; i < editors; i += 1) if (isWriter(i)) writerCount += 1;

  const result = {
    schemaVersion: 1,
    label,
    protocol: "docs/benchmarks.md",
    startedAt,
    wallSeconds: (Date.now() - wallStart) / 1000,
    quietCheck: skipQuietCheck
      ? { skipped: true }
      : {
          skipped: false,
          quiet: quiet.quiet,
          waitedSeconds: quiet.waitedMs / 1000,
          idlePercent: quiet.sample.idlePercent,
          busiestProcessPercent: quiet.sample.top[0]?.cpu ?? 0,
        },
    ...where,
    services: await serviceVersions(),
    parameters: {
      editors,
      writers: writerCount,
      readers: editors - writerCount,
      scenario: writerShare === 1 ? "all-write" : "one-in-five",
      writerShare,
      editsPerSecondPerWriter: ratePerWriter,
      readerCursorIntervalMs,
      warmupSeconds,
      durationSeconds,
      drainSeconds,
      generatorProcesses: workerCount,
      editorsPerGeneratorProcess: perWorker,
      server: {
        command: "node --import tsx src/main.ts",
        nodeEnv: "production",
        redisAdapter: true,
        postgresPersistence: true,
        limits: "defaults",
        instances: 1,
      },
    },
    traffic: {
      editsInWindow: joined.edits,
      editsPerSecond: joined.edits / seconds,
      syncMessagesDeliveredPerSecond: messages.sync / seconds,
      awarenessMessagesDeliveredPerSecond: messages.awareness / seconds,
    },
    latencyMs: latency,
    latencyHistogram: histogram(joined.latencies),
    delivery: {
      expected: joined.expected,
      observed: joined.observed,
      missing: joined.missing,
      duplicates: joined.duplicates,
      unmatched: joined.unmatched,
      negative: joined.negative,
    },
    server: serverStats,
    clockSkewBetweenGeneratorsAndOrchestrator: skews,
    generator: results.map((r) => ({
      process: r.workerIndex,
      eventLoopDelayMs: r.lag,
      cpuPercentOfOneCore: ((r.cpuMs.user + r.cpuMs.system) / r.windowMs) * 100,
    })),
    integrity: {
      editorsWithTheCommonFinalDocument: commonCount,
      databaseHoldsTheFinalDocument: persistedMismatch === 0,
      disconnects: results.reduce((n, r) => n + r.disconnects, 0),
      rejections: results.reduce((n, r) => n + r.rejections, 0),
      refusedHandshakes: results.reduce((n, r) => n + r.connectErrors.length, 0),
      serverWarningsAndErrors: logLines.length,
    },
    verdict,
  };

  mkdirSync(path.dirname(path.resolve(repoRoot, out)), { recursive: true });
  writeFileSync(path.resolve(repoRoot, out), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `${label}: ${verdict.status}  p50 ${latency.p50.toFixed(1)}  p95 ${latency.p95.toFixed(1)}  p99 ${latency.p99.toFixed(1)} ms  ` +
      `(${joined.observed} samples, server rss max ${serverStats.rssMiB.windowMax.toFixed(0)} MiB, cpu ${serverStats.cpuPercentOfOneCore.windowMean.toFixed(0)}%)`,
  );
  for (const reason of [...verdict.invalid, ...verdict.failed]) console.log(`  - ${reason}`);

  for (const worker of workers) worker.send({ type: "exit" });
  await removeFixture(pool);
  await pool.end();
}

async function shutdown(): Promise<void> {
  for (const child of children) child.kill("SIGTERM");
  await sleep(500);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

main().then(
  async () => {
    await shutdown();
    process.exit(0);
  },
  async (error: unknown) => {
    console.error(error);
    await removeFixture(pool).catch(() => {});
    await pool.end().catch(() => {});
    await shutdown();
    process.exit(1);
  },
);
