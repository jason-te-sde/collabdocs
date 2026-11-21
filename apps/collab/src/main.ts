import { optionsFromEnv } from "./config";
import { consoleLogger } from "./logger";
import { startCollabServer } from "./server";

async function main(): Promise<void> {
  const server = await startCollabServer(optionsFromEnv(process.env));
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    consoleLogger.info("shutting down", { signal });
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        consoleLogger.error("shutdown failed", { error: String(error) });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error: unknown) => {
  consoleLogger.error("could not start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
