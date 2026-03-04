# async-mutex-lite

> 🔒 Tiny keyed async mutex for JavaScript & TypeScript — ~400–600 bytes gzip, zero dependencies.

Have you ever run into a situation where two async processes run at the same time and produce inconsistent results? That’s exactly the problem this library solves.

**async-mutex-lite** ensures that tasks with the same key run **sequentially**, while tasks with different keys can still run **in parallel** without interfering with each other.

```
npm install async-mutex-lite
```

---

## Table of Contents

- [Why This Library Exists](#why-this-library-exists)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Basic Usage](#basic-usage)
- [When Should You Use It?](#when-should-you-use-it)
- [API Reference](#api-reference)
- [Error Strategy](#error-strategy)
- [Real World Examples](#real-world-examples)
- [Comparison With Other Libraries](#comparison-with-other-libraries)
- [FAQ](#faq)
- [License](#license)

---

# Why This Library Exists

JavaScript is single-threaded, but **race conditions can still happen** when using `async/await`.

Imagine this scenario:

```ts
// ❌ Dangerous — two requests arrive at the same time for the same user
app.post("/checkout", async (req) => {
  const balance = await getBalance(req.userId) // both read: $100

  if (balance >= req.amount) {
    await deductBalance(req.userId, req.amount) // both deduct
    await createOrder(req.userId)
  }
})
```

If two requests arrive almost simultaneously, they may both read the same balance before either has deducted it. The result: **the balance gets deducted twice**, but maybe only one order is created — or worse.

With `async-mutex-lite`:

```ts
// ✅ Safe — requests for the same user are processed sequentially
app.post("/checkout", async (req) => {
  await mutex(`checkout:${req.userId}`, async () => {
    const balance = await getBalance(req.userId)

    if (balance >= req.amount) {
      await deductBalance(req.userId, req.amount)
      await createOrder(req.userId)
    }
  })
})
```

Requests from other users (different `userId`) can still run in parallel — only requests for **the same user** are queued.

---

# How It Works

This library uses **Promise chaining** instead of a traditional queue.

```
mutex("user:1", taskA)  ─┐
mutex("user:1", taskB)  ─┼─► taskA → taskB → taskC  (sequential, FIFO)
mutex("user:1", taskC)  ─┘

mutex("user:2", taskD)  ────► taskD  (parallel)
```

Each key has its own promise chain.  
New tasks always wait for the previous task in the chain to finish.

After all tasks complete, the internal memory is cleaned automatically — **no memory leaks**.

---

# Installation

```bash
# npm
npm install async-mutex-lite

# pnpm
pnpm add async-mutex-lite

# yarn
yarn add async-mutex-lite

# bun
bun add async-mutex-lite
```

Compatible with:

- Node.js 16+
- Modern browsers
- Bun
- Deno
- Serverless environments (Vercel, Cloudflare Workers, etc.)

---

# Basic Usage

```ts
import { mutex } from "async-mutex-lite"

// Async function
const result = await mutex("my-key", async () => {
  const data = await fetchSomething()
  return data
})

// Sync functions are also supported
const value = await mutex("my-key", () => {
  return 42
})
```

---

# When Should You Use It?

Use `async-mutex-lite` when you have async operations that **must not run concurrently for the same resource**.

## ✅ Good Use Cases

### Financial transactions
Prevent double-charges or negative balances.

```ts
await mutex(`wallet:${userId}`, () => processPayment(userId, amount))
```

### Prevent duplicate webhook processing

```ts
await mutex(`webhook:${webhookId}`, () => processWebhook(webhookId))
```

### File write operations

```ts
await mutex("log-file", () => fs.appendFile("app.log", logLine))
```

### Cache stampede prevention

```ts
async function getCachedUser(userId: string) {
  if (cache.has(userId)) return cache.get(userId)

  return mutex(`cache:${userId}`, async () => {
    if (cache.has(userId)) return cache.get(userId)

    const user = await db.findUser(userId)
    cache.set(userId, user)
    return user
  })
}
```

### Inventory updates

```ts
await mutex(`product:${productId}`, async () => {
  const stock = await getStock(productId)
  if (stock > 0) await decrementStock(productId)
})
```

### Per-user rate limiting

```ts
await mutex(`api-call:${userId}`, () => callExternalAPI(userId))
```

---

## ❌ When You Don't Need It

- Stateless operations
- Pure read operations
- Code that is already sequential
- CPU-bound workloads

Mutex only helps with **concurrency on shared async state**.

---

# API Reference

### `mutex(key, task, options?)`

```ts
function mutex<T>(
  key: string,
  task: () => Promise<T> | T,
  options?: MutexOptions
): Promise<T | undefined>
```

---

## Parameters

| Parameter | Type | Required | Description |
|----------|------|---------|-------------|
| `key` | `string` | ✅ | Resource identifier. Tasks with the same key are queued. |
| `task` | `() => Promise<T> \| T` | ✅ | Function to execute. Can be async or sync. |
| `options` | `MutexOptions` | ❌ | Optional configuration. |

---

## Return Value

Returns the value returned by `task`.

If a task is skipped due to `"stop"` strategy, the return value will be `undefined`.

---

# MutexOptions

```ts
interface MutexOptions {
  onError?: "continue" | "stop"
}
```

Default:

```
continue
```

---

# Error Strategy

## `"continue"` (default)

The queue continues even if a task fails.

```ts
const t1 = mutex("key", () => { throw new Error("failed") }).catch(console.error)
const t2 = mutex("key", () => "this task still runs ✅")

await Promise.all([t1, t2])
```

Use this when failures **should not block other tasks**.

---

## `"stop"`

If a task fails with `"stop"` strategy, all pending tasks in the same queue are cancelled.

```ts
const t1 = mutex("key", () => { throw new Error("failed") }, { onError: "stop" })
  .catch(console.error)

const t2 = mutex("key", () => "this task will NOT run ❌")

await Promise.allSettled([t1, t2])
```

Use this for **all-or-nothing operations**, like transactional workflows.

After the queue drains, the key resets automatically.

---

# Real World Examples

## Express.js Checkout API

```ts
import express from "express"
import { mutex } from "async-mutex-lite"

const app = express()

app.post("/checkout", async (req, res) => {
  const { userId, productId, quantity } = req.body

  try {
    await mutex(`checkout:${userId}`, async () => {
      const [balance, stock] = await Promise.all([
        getBalance(userId),
        getStock(productId),
      ])

      if (balance < req.body.total) throw new Error("Insufficient balance")
      if (stock < quantity) throw new Error("Insufficient stock")

      await Promise.all([
        deductBalance(userId, req.body.total),
        deductStock(productId, quantity),
        createOrder({ userId, productId, quantity }),
      ])
    })

    res.json({ success: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})
```

---

## Next.js API Route — Prevent Duplicate Submission

```ts
import { mutex } from "async-mutex-lite"

export async function POST(req: Request) {
  const { email } = await req.json()

  await mutex(`subscribe:${email}`, async () => {
    const exists = await db.user.findUnique({ where: { email } })
    if (exists) throw new Error("Email already registered")

    await db.user.create({ data: { email } })
    await sendWelcomeEmail(email)
  })

  return Response.json({ message: "Subscription successful!" })
}
```

---

## Webhook Handler — Idempotent Processing

```ts
import { mutex } from "async-mutex-lite"

async function handleWebhook(event: WebhookEvent) {
  await mutex(`webhook:${event.id}`, async () => {
    const alreadyProcessed = await db.webhook.findUnique({
      where: { id: event.id }
    })

    if (alreadyProcessed) return

    await processEvent(event)
    await db.webhook.create({ data: { id: event.id } })
  })
}
```

---

## TypeScript — Generic Type Inference

```ts
const user = await mutex("fetch-user", async () => {
  return await db.user.findFirst()
})

// user: User | null | undefined
```

---

# Comparison With Other Libraries

| Library | Size | Keyed Lock | Error Strategy | TypeScript |
|--------|------|------------|---------------|------------|
| async-lock | ~5 KB | ✅ | ❌ | Partial |
| async-mutex | ~3 KB | ❌ | ❌ | ✅ |
| await-lock | ~1 KB | ❌ | ❌ | ❌ |
| **async-mutex-lite** | **~0.5 KB** | **✅** | **✅** | **✅** |

---

# FAQ

### Is this production ready?

Yes. The library has no dependencies, a very small surface area, and 100% test coverage.

---

### Does it work in serverless environments?

Yes, but remember: each serverless instance has its own memory.

Mutex works only when conflicting requests are handled by the **same instance**.  
For cross-instance coordination you still need an external lock (e.g., Redis).

---

### Is FIFO guaranteed?

Yes. Tasks are executed exactly in the order they were scheduled.

---

### What if `task` returns `undefined`?

Then `mutex` returns `undefined`.  
This is indistinguishable from a skipped task when using `"stop"` strategy.

---

### Does it support CommonJS?

Yes. The package provides both **ESM (`.js`) and CommonJS (`.cjs`) builds**.

---

# Development

```bash
git clone https://github.com/deni-irawan-nugraha/async-mutex-lite.git
cd async-mutex-lite

npm install
npm test
npm run test:coverage
npm run test:bench
npm run build
```

---

# License

MIT License — free to use, modify, and distribute.

---

<div align="center">

Made with ❤️ by **Deni Irawan Nugraha**

GitHub: https://github.com/deni-irawan-nugraha  
npm: https://www.npmjs.com/package/async-mutex-lite

</div>