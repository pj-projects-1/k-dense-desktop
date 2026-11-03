import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyRuntimeTree } from "../scripts/runtime-files.mjs";

test("staged Next dependencies survive moving away from the build checkout", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-copy-"));
  try {
    const source = path.join(dir,"source");
    const destination = path.join(dir,"app");
    fs.mkdirSync(path.join(source,".next/node_modules"),{recursive:true});
    fs.mkdirSync(path.join(source,"node_modules/pkg"),{recursive:true});
    fs.writeFileSync(path.join(source,"node_modules/pkg/cli.js"),"console.log('works')",{mode:0o755});
    fs.symlinkSync("../../node_modules/pkg",path.join(source,".next/node_modules/pkg-traced"));
    copyRuntimeTree(source,destination);
    const traced = path.join(destination,".next/node_modules/pkg-traced");
    assert.equal(fs.lstatSync(traced).isSymbolicLink(),false);
    fs.rmSync(source,{recursive:true});
    assert.equal(fs.readFileSync(path.join(traced,"cli.js"),"utf8"),"console.log('works')");
    fs.accessSync(path.join(traced,"cli.js"),fs.constants.X_OK);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
