import { describe, it, expect, vi } from "vitest";

// The shared transaction runner every Phase 3 service writes through.
//
// The property under test is narrow but load-bearing: a recognised concurrency
// error re-runs the WHOLE transaction (never a catch-and-continue inside it,
// which on PostgreSQL would be operating on an already-aborted transaction),
// and anything else propagates untouched so a real defect is never hidden by a
// retry loop.

const {
  MAX_TRANSACTION_ATTEMPTS,
  TRANSACTION_ISOLATION_LEVEL,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  retryDelayMs,
  isRetryableConcurrencyError,
  runSerializable,
  runAtomic,
} = require("../../src/services/workflow/workflowTransaction");

function prismaError(code) {
  const error = new Error(`prisma failure ${code}`);
  error.code = code;
  return error;
}

/** Records how each transaction was opened, so the isolation level is checkable. */
function trackingClient(handler) {
  const calls = [];
  return {
    calls,
    async $transaction(fn, options) {
      calls.push(options);
      return fn({ attempt: calls.length, ...handler });
    },
  };
}

describe("isRetryableConcurrencyError", () => {
  it("recognises a unique violation and a write conflict", () => {
    expect(isRetryableConcurrencyError(prismaError("P2002"))).toBe(true);
    expect(isRetryableConcurrencyError(prismaError("P2034"))).toBe(true);
  });

  // A PrismaClientUnknownRequestError (code undefined) is the signature of a
  // genuinely broken transaction — typically SQLSTATE 25P02, "current
  // transaction is aborted" — not a resolvable race. Retrying it would hide a
  // real defect behind five identical failures.
  it("does not recognise an error with no code, or an unrelated one", () => {
    expect(isRetryableConcurrencyError(new Error("boom"))).toBe(false);
    expect(isRetryableConcurrencyError(prismaError("P2025"))).toBe(false);
    expect(isRetryableConcurrencyError(prismaError(undefined))).toBe(false);
    expect(isRetryableConcurrencyError(null)).toBe(false);
    expect(isRetryableConcurrencyError(undefined)).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("grows with the attempt number and stays inside its cap", () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const delay = retryDelayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS);
      expect(delay).toBeLessThan(RETRY_MAX_DELAY_MS + RETRY_BASE_DELAY_MS);
    }
    // The floor rises until the cap is reached.
    expect(retryDelayMs(1)).toBeLessThan(RETRY_MAX_DELAY_MS + RETRY_BASE_DELAY_MS);
    expect(retryDelayMs(20)).toBeGreaterThanOrEqual(RETRY_MAX_DELAY_MS);
  });

  // Retrying at the same instant is how a retry budget gets burned without
  // making progress: every loser wakes together and re-collides in lockstep.
  it("carries jitter, so concurrent losers do not wake in lockstep", () => {
    const delays = new Set(Array.from({ length: 40 }, () => retryDelayMs(2)));
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe("runSerializable", () => {
  it("opens the transaction at SERIALIZABLE and returns the callback's value", async () => {
    const client = trackingClient({});
    const result = await runSerializable(client, async () => "done");

    expect(result).toBe("done");
    expect(client.calls).toEqual([{ isolationLevel: TRANSACTION_ISOLATION_LEVEL }]);
  });

  it("re-runs the ENTIRE transaction on a retryable error, then succeeds", async () => {
    let attempts = 0;
    const client = {
      async $transaction(fn) {
        attempts += 1;
        return fn({});
      },
    };

    const result = await runSerializable(client, async () => {
      if (attempts < 3) throw prismaError("P2034");
      return `succeeded on attempt ${attempts}`;
    });

    expect(result).toBe("succeeded on attempt 3");
    expect(attempts).toBe(3);
  });

  it("gives up after the bounded attempt budget and rethrows the real error", async () => {
    let attempts = 0;
    const client = {
      async $transaction(fn) {
        attempts += 1;
        return fn({});
      },
    };

    const failing = runSerializable(client, async () => {
      throw prismaError("P2002");
    });

    await expect(failing).rejects.toMatchObject({ code: "P2002" });
    expect(attempts).toBe(MAX_TRANSACTION_ATTEMPTS);
  });

  it("never retries a non-concurrency error", async () => {
    let attempts = 0;
    const client = {
      async $transaction(fn) {
        attempts += 1;
        return fn({});
      },
    };

    await expect(
      runSerializable(client, async () => {
        throw new Error("ownership does not permit linking");
      })
    ).rejects.toThrow("ownership does not permit linking");
    expect(attempts).toBe(1);
  });

  it("waits between attempts rather than retrying immediately", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const client = {
        async $transaction(fn) {
          attempts += 1;
          return fn({});
        },
      };

      const pending = runSerializable(client, async () => {
        if (attempts < 2) throw prismaError("P2034");
        return "ok";
      });

      // The first attempt has failed and the runner is now sleeping, so the
      // second has not started.
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(RETRY_MAX_DELAY_MS + RETRY_BASE_DELAY_MS);
      await expect(pending).resolves.toBe("ok");
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runAtomic", () => {
  // Purely additive transactions take no isolation level at all: SERIALIZABLE
  // would take predicate locks on the unique indexes they insert into and make
  // unrelated concurrent inserts conflict on index-page adjacency.
  it("opens the transaction at the connection default", async () => {
    const client = trackingClient({});
    const result = await runAtomic(client, async () => "created");

    expect(result).toBe("created");
    expect(client.calls).toEqual([{}]);
  });

  it("still re-runs the whole transaction on a retryable error", async () => {
    let attempts = 0;
    const client = {
      async $transaction(fn) {
        attempts += 1;
        return fn({});
      },
    };

    const result = await runAtomic(client, async () => {
      if (attempts < 2) throw prismaError("P2002");
      return "created";
    });

    expect(result).toBe("created");
    expect(attempts).toBe(2);
  });
});
