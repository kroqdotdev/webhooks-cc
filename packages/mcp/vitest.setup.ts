import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never read or write the real agent credential file.
process.env.WHK_AGENT_FILE = join(mkdtempSync(join(tmpdir(), "whk-sdk-test-")), "agent.json");
