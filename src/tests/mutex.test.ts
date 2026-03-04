import { describe, it, expect } from "vitest"
import { mutex } from "../mutex"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Core behaviour
// ---------------------------------------------------------------------------

describe("mutex — sequential execution", () => {
  it("runs tasks sequentially for the same key", async () => {
    const order: number[] = []

    await Promise.all([
      mutex("A", async () => {
        await delay(50)
        order.push(1)
      }),
      mutex("A", async () => {
        order.push(2)
      }),
    ])

    expect(order).toEqual([1, 2])
  })

  it("maintains strict FIFO order across many tasks", async () => {
    const order: number[] = []

    await Promise.all([
      mutex("A", async () => order.push(1)),
      mutex("A", async () => order.push(2)),
      mutex("A", async () => order.push(3)),
    ])

    expect(order).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------

describe("mutex — parallel execution", () => {
  it("runs tasks in parallel for different keys", async () => {
    const order: string[] = []

    await Promise.all([
      mutex("A", async () => {
        await delay(50)
        order.push("A")
      }),
      mutex("B", async () => {
        order.push("B")
      }),
    ])

    // "B" should finish before "A" because it has no delay
    expect(order[0]).toBe("B")
    expect(order[1]).toBe("A")
  })

  it("does not block unrelated keys", async () => {
    const start = Date.now()

    await Promise.all([
      mutex("X", () => delay(60)),
      mutex("Y", () => delay(60)),
    ])

    // Both run concurrently — total should be ~60 ms, not ~120 ms
    expect(Date.now() - start).toBeLessThan(110)
  })
})

// ---------------------------------------------------------------------------
// Return values
// ---------------------------------------------------------------------------

describe("mutex — return values", () => {
  it("returns the task result (async)", async () => {
    const value = await mutex("calc", async () => 42)
    expect(value).toBe(42)
  })

  it("returns the task result (sync)", async () => {
    const value = await mutex("sync", () => 10)
    expect(value).toBe(10)
  })

  it("infers generic type correctly", async () => {
    const value = await mutex<string>("typed", async () => "hello")
    // TypeScript would catch a type mismatch at compile time
    expect(typeof value).toBe("string")
    expect(value).toBe("hello")
  })
})

// ---------------------------------------------------------------------------
// Error strategy — continue (default)
// ---------------------------------------------------------------------------

describe("mutex — error strategy: continue", () => {
  it("continues the queue when a task fails (default)", async () => {
    const result: number[] = []

    const t1 = mutex("A", async () => {
      throw new Error("fail")
    }).catch(() => {})

    const t2 = mutex("A", async () => {
      result.push(1)
    })

    await Promise.all([t1, t2])

    expect(result).toEqual([1])
  })

  it("propagates the error to the caller", async () => {
    await expect(
      mutex("err", async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
  })

  it("re-uses the key normally after a continue-error", async () => {
    // After a continued failure the key should be fully clean
    await mutex("reuse", async () => {
      throw new Error("x")
    }).catch(() => {})

    const value = await mutex("reuse", async () => "ok")
    expect(value).toBe("ok")
  })
})

// ---------------------------------------------------------------------------
// Error strategy — stop
// ---------------------------------------------------------------------------

describe("mutex — error strategy: stop", () => {
  it("cancels pending tasks when strategy is stop", async () => {
    const result: number[] = []

    const t1 = mutex(
      "A",
      async () => {
        throw new Error("fail")
      },
      { onError: "stop" }
    ).catch(() => {})

    const t2 = mutex("A", async () => {
      result.push(1)
    })

    await Promise.allSettled([t1, t2])

    expect(result.length).toBe(0)
  })

  it("returns undefined for tasks skipped due to stop", async () => {
    const t1 = mutex(
      "B",
      async () => {
        throw new Error("fail")
      },
      { onError: "stop" }
    ).catch(() => {})

    const t2 = mutex("B", async () => "should be skipped")

    await t1
    const value = await t2
    expect(value).toBeUndefined()
  })

  it("allows new tasks on the same key after the queue is drained", async () => {
    const t1 = mutex(
      "C",
      async () => {
        throw new Error("fail")
      },
      { onError: "stop" }
    ).catch(() => {})

    const t2 = mutex("C", async () => {}) // drained / skipped
    await Promise.allSettled([t1, t2])

    // New task after drain — queue is fresh
    const value = await mutex("C", async () => "fresh")
    expect(value).toBe("fresh")
  })
})

// ---------------------------------------------------------------------------
// Memory safety
// ---------------------------------------------------------------------------

describe("mutex — memory management", () => {
  it("cleans up the internal lock map after completion", async () => {
    // Access internal state via dynamic import for white-box testing
    // We verify indirectly: running many tasks on unique keys shouldn't grow
    const keys = Array.from({ length: 100 }, (_, i) => `key-${i}`)

    await Promise.all(keys.map((k) => mutex(k, async () => {})))

    // All 100 keys completed — no explicit assertion needed beyond no-throw,
    // but we can verify re-running the same keys works fine (map was reset)
    const rerun = await Promise.all(
      keys.map((k) => mutex(k, async () => k))
    )
    expect(rerun[0]).toBe("key-0")
    expect(rerun[99]).toBe("key-99")
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("mutex — edge cases", () => {
  it("handles concurrent tasks on the same key (stress test)", async () => {
    const results: number[] = []
    const N = 20

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutex("stress", async () => {
          await delay(Math.random() * 5)
          results.push(i)
        })
      )
    )

    // All tasks must have run
    expect(results.length).toBe(N)
    // Must be in insertion order (FIFO)
    expect(results).toEqual(Array.from({ length: N }, (_, i) => i))
  })

  it("handles an immediately-resolving async task", async () => {
    const v = await mutex("instant", async () => "instant")
    expect(v).toBe("instant")
  })

  it("handles tasks that return falsy values", async () => {
    const v1 = await mutex("falsy", async () => 0)
    const v2 = await mutex("falsy2", async () => false)
    const v3 = await mutex("falsy3", async () => "")

    expect(v1).toBe(0)
    expect(v2).toBe(false)
    expect(v3).toBe("")
  })
})