import { bench, describe } from "vitest";
import { mutex } from "../mutex";

describe("mutex — throughput", () => {
  bench("single task", async () => {
    await mutex("bench-single", async () => {});
  });

  bench("10 sequential tasks on same key", async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => mutex("bench-seq", async () => {})),
    );
  });

  bench("10 parallel tasks on different keys", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutex(`bench-par-${i}`, async () => {}),
      ),
    );
  });
});
