/**
 * Suppress known unhandled rejections from convex-test's scheduler.
 *
 * When a mutation calls ctx.scheduler.runAfter(0, ...), convex-test fires
 * the scheduled function asynchronously after the transaction commits. If the
 * test finishes before the scheduled function completes, convex-test throws
 * "Write outside of transaction" -- a benign race condition in the test harness
 * that does not affect test correctness.
 */
process.on("unhandledRejection", (reason: unknown) => {
  if (reason instanceof Error && reason.message.includes("Write outside of transaction")) {
    // Suppress known convex-test scheduler race condition
    return;
  }
  // Re-throw unexpected rejections
  throw reason;
});
