import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const exec = promisify(execFile);
const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "sync-npm-readme.mjs");

const mod = (await import(SCRIPT)) as { npmReadme: (source: string) => string };

describe("the npm README", () => {
  it("is the repository README with absolute links", () => {
    const out = mod.npmReadme(
      '<img src="docs/assets/banner.png" />\n[guide](docs/guide.md) [security](docs/quickstart.md) [top](#install) [x](https://x.dev)\n',
    );
    assert.match(
      out,
      /src="https:\/\/raw\.githubusercontent\.com\/junxi25liu\/oguri\/main\/docs\/assets\/banner\.png"/,
    );
    assert.match(
      out,
      /\[guide\]\(https:\/\/github\.com\/junxi25liu\/oguri\/blob\/main\/docs\/guide\.md\)/,
    );
    assert.match(
      out,
      /\[security\]\(https:\/\/github\.com\/junxi25liu\/oguri\/blob\/main\/docs\/quickstart\.md\)/,
    );
    assert.match(out, /\[top\]\(#install\)/);
    assert.match(out, /\[x\]\(https:\/\/x\.dev\)/);
  });

  it("is in sync with the repository README", async () => {
    const { stdout } = await exec(process.execPath, [SCRIPT, "--check"]);
    assert.match(stdout, /in sync/);
  });
});
