/**
 * Startup-failure tests for the desktop shell.
 *
 * Run against real sockets, not mocks: the bug these cover — a readiness probe
 * that accepted any server on the port — only reproduces when something
 * genuinely owns it.
 *
 *     node --test desktop/test/startup.test.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { BACKEND_PORT } from "../service-manager.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** An HTTP server that answers /health the way a *different* Kady would. */
function startImpostor(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>someone else</title>");
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

describe("healthBelongsToLaunch", () => {
  it("accepts a reply carrying this launch's token", async () => {
    const { healthBelongsToLaunch } = await import("../service-manager.mjs");
    assert.equal(healthBelongsToLaunch({ launchToken: "abc" }, "abc"), true);
  });

  it("rejects a healthy reply from a program we did not start", async () => {
    const { healthBelongsToLaunch } = await import("../service-manager.mjs");
    // This is the exact shape the impostor returns: healthy, no token.
    assert.equal(healthBelongsToLaunch({ status: "ok" }, "abc"), false);
    // A different launch's token is equally not ours.
    assert.equal(healthBelongsToLaunch({ launchToken: "other" }, "abc"), false);
    // A backend started by hand has no token at all.
    assert.equal(healthBelongsToLaunch(null, "abc"), false);
  });
});

describe("startServices with the backend port already taken", () => {
  let impostor = null;

  before(async () => {
    // If something already owns 8000 (a dev server, a running Kady) that is
    // exactly the situation under test, so use it. Otherwise stand one up.
    impostor = await startImpostor(BACKEND_PORT).catch(() => null);
  });

  after(async () => {
    if (impostor) await new Promise((resolve) => impostor.close(resolve));
  });

  it("refuses to start and names the port", async () => {
    // The old code spawned anyway, our child died with EADDRINUSE, and the
    // probe accepted whatever answered the port — so the window opened against
    // a backend whose projects directory was elsewhere and the UI loaded
    // forever. Refusing is the fix; the message is what makes it actionable.
    const { startServices } = await import("../service-manager.mjs");
    const result = await startServices({
      dataRoot: path.join(repoRoot, "desktop", "test", ".tmp-data"),
    });

    assert.equal(result.ok, false);
    assert.ok(result.detail.includes(String(BACKEND_PORT)));
    assert.match(result.detail, process.platform === "win32" ? /netstat/ : /lsof/);
    assert.doesNotMatch(result.detail, /did not become ready/);
  });
});
