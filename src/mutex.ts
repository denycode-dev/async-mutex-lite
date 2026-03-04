export type ErrorStrategy = "continue" | "stop";

export interface MutexOptions {
  onError?: ErrorStrategy;
}

// Internal state — module-level singletons (not exported to keep API clean)
const locks = new Map<string, Promise<void>>();
const stopped = new Set<string>();

/**
 * Keyed async mutex — runs tasks sequentially per key,
 * parallel across different keys.
 *
 * @param key     - Resource identifier (e.g. "payment:user-1")
 * @param fn      - Sync or async task to execute
 * @param options - Optional error strategy ("continue" | "stop")
 * @returns       - Resolves with the task's return value
 *
 * @example
 * const result = await mutex("user:1", async () => fetchData())
 */
export async function mutex<T>(
  key: string,
  fn: () => Promise<T> | T,
  options: MutexOptions = {},
): Promise<T | undefined> {
  const strategy = options.onError ?? "continue";

  // Grab the tail of the current chain (or a resolved no-op if none)
  const prev = locks.get(key) ?? Promise.resolve();

  // Create the "gate" promise for this slot — resolved once this task finishes
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Store `next` as the tail of this key's queue.
  // Sequencing is enforced by `await prev` below — NOT by chaining into locks.
  // This makes `locks.get(key) === next` a reliable "am I last?" check for cleanup.
  locks.set(key, next);

  // Wait for all tasks ahead of us in the queue
  await prev;

  // If this queue was cancelled by a prior "stop" error, skip and unblock
  if (stopped.has(key)) {
    release();
    // Clean up if we're the last in the chain
    if (locks.get(key) === next) {
      locks.delete(key);
      stopped.delete(key);
    }
    return undefined;
  }

  try {
    return await fn();
  } catch (err) {
    if (strategy === "stop") {
      stopped.add(key);
    }
    throw err;
  } finally {
    release();

    // Clean up map entry when we're the last in the chain (no memory leak).
    // Only clear `stopped` here too — once the queue is fully drained there
    // are no more pending tasks that need to be skipped, so the next fresh
    // task on this key should run normally.
    if (locks.get(key) === next) {
      locks.delete(key);
      // Safe to clear stopped only after the lock entry is gone, ensuring
      // any task that was already waiting (and checked stopped=true) has
      // already bailed out before we reset the flag.
      stopped.delete(key);
    }
  }
}
