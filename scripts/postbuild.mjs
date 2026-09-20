/**
 * Mark the built entrypoints executable so they can be run straight from the
 * repo (`./dist/cli.js`) without an npm install to set the bit for us.
 *
 * Done in Node rather than `chmod` in the npm script: `chmod` does not exist on
 * Windows, where it would fail the whole build. `fs.chmodSync` is a documented
 * no-op there instead.
 */
import fs from "node:fs";

for (const f of ["dist/cli.js", "dist/mcp.js"]) {
  if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
}
