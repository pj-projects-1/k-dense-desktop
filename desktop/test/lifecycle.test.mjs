import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServices, stopServices, BACKEND_PORT, FRONTEND_PORT } from "../service-manager.mjs";

test("packaged services bind loopback, preserve data, and terminate their process trees", { skip: process.platform === "win32", timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "Kady app with spaces "));
  const dataRoot = path.join(dir, "data");
  fs.mkdirSync(dataRoot);
  const marker = path.join(dataRoot, "keep.txt");
  fs.writeFileSync(marker, "user data");
  const backend = path.join(dir, "backend.mjs");
  fs.writeFileSync(backend, `
    import http from 'node:http';
    import fs from 'node:fs';
    import path from 'node:path';
    import {spawn} from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'ignore'});
    fs.writeFileSync(path.join(process.env.KADY_DATA_ROOT,'child.pid'),String(child.pid));
    http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({launchToken:process.env.KADY_LAUNCH_TOKEN}));}).listen(Number(process.env.KADY_PORT),process.env.KADY_HOST);
  `);
  fs.writeFileSync(path.join(dir, "server.js"), `require('node:http').createServer((req,res)=>res.end('frontend')).listen(Number(process.env.PORT),process.env.HOSTNAME);`);
  let pid;
  try {
    const result = await startServices({ dataRoot, backendBundle: backend, standaloneDir: dir });
    assert.equal(result.ok, true, result.detail);
    assert.equal(await (await fetch(`http://127.0.0.1:${FRONTEND_PORT}`)).text(), "frontend");
    pid = Number(fs.readFileSync(path.join(dataRoot, "child.pid"), "utf8"));
    process.kill(pid, 0);
    await stopServices();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(fs.readFileSync(marker, "utf8"), "user data");
    await assert.rejects(fetch(`http://127.0.0.1:${FRONTEND_PORT}`));
    await assert.rejects(fetch(`http://127.0.0.1:${BACKEND_PORT}/health`));
  } finally {
    await stopServices();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
