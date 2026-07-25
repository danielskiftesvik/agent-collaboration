// Preload for the test suite: ignore the developer's real
// ~/.agent-collaboration/config.json so defaults/instances never bleed into CI
// or local runs. Individual tests that need instances set
// AGENT_COLLAB_INSTANCE_CONFIG themselves (and call _clearInstanceCache).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const empty = path.join(os.tmpdir(), "agent-collab-empty-instance-config.json");
if (!fs.existsSync(empty)) fs.writeFileSync(empty, "{}\n");
process.env.AGENT_COLLAB_INSTANCE_CONFIG = empty;
