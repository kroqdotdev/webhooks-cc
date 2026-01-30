import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Clean up expired ephemeral endpoints every 5 minutes
crons.interval("cleanup expired endpoints", { minutes: 5 }, internal.requests.cleanupExpired);

// Check billing period resets daily at midnight UTC
crons.daily(
  "check billing period resets",
  { hourUTC: 0, minuteUTC: 0 },
  internal.billing.checkPeriodResets
);

export default crons;
