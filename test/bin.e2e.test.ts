import { execFile } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * The shipped artifact, invoked the way npm invokes it.
 *
 * 0.1.0 and 0.1.1 both passed every unit test and both exited 0 with NO output
 * under `npx`, because npm installs the bin as a symlink and the entrypoint
 * check compared the real module URL against the symlink path. Running
 * `node dist/cli.js` — which is what a test naturally does — took the working
 * path and hid it. This test only proves anything through a symlink.
 */
describe("packaged bin", () => {
  const cli = resolve("dist/cli.js");

  it("runs when invoked through a node_modules/.bin style symlink", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rh-bin-"));
    const link = join(dir, "reverse-harness");
    try {
      symlinkSync(cli, link);
      const { stdout } = await run(process.execPath, [link, "--version"]);
      expect(stdout.trim()).toBe("0.2.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs when invoked directly", async () => {
    const { stdout } = await run(process.execPath, [cli, "--version"]);
    expect(stdout.trim()).toBe("0.2.0");
  });
});
