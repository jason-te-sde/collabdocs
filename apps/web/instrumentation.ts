/** Runs once when the server starts: a deployment that cannot work safely does not start. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertRuntimeConfig } = await import("./lib/config");
  assertRuntimeConfig();
}
