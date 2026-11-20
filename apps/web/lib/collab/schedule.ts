/**
 * Scheduling helpers that keep the editor's start-up work out of one long task.
 * The page paints its shell first; each piece of start-up work then runs in a task of
 * its own, so the main thread can answer input and paint between them.
 */

/** Runs `task` when the browser is idle, or after at most `timeoutMs`. Returns a canceller. */
export function whenIdle(task: () => void, timeoutMs = 300): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 1);
  return () => window.clearTimeout(handle);
}

/** Resolves in a later task, after the browser has had a chance to paint and handle input. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
