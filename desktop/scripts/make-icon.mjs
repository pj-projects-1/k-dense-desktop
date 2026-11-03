/**
 * Generate the Windows app icon from the brand logo.
 *
 * electron-builder wants `resources/icon.ico`; the repo only has the upstream
 * PNG, which is a wide lockup (11397x3508) plus a near-square mark. An ico is
 * seven PNGs in a container, so this builds it without an image toolchain
 * dependency beyond sharp (already present for the web build's image work).
 *
 * Usage: node scripts/make-icon.mjs
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const resourcesDir = path.join(here, "..", "resources");

// The near-square mark; the wide `kdense-logo.png` is wordmark text and would
// be an unreadable smear at 16px.
const SOURCE = path.join(repoRoot, "web", "public", "k-dense-logo.png");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const CANVAS = 1024;

const require = createRequire(path.join(repoRoot, "web", "package.json"));
const sharp = require("sharp");

async function main() {
  if (!fs.existsSync(SOURCE)) throw new Error(`missing brand logo: ${SOURCE}`);
  fs.mkdirSync(resourcesDir, { recursive: true });

  // Windows centres a square icon, so pad rather than stretch: the source is
  // 744x717 and distorting it would be visible at every size.
  const logo = await sharp(SOURCE).trim({ threshold: 1 }).toBuffer();
  const { width, height } = await sharp(logo).metadata();
  const scale = Math.min(CANVAS / width, CANVAS / height);
  const scaled = await sharp(logo)
    .resize(Math.round(width * scale), Math.round(height * scale), { fit: "inside" })
    .toBuffer();
  const square = await sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: scaled, gravity: "centre" }])
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(resourcesDir, "icon.png"), square);
  console.log(`icon.png ${CANVAS}x${CANVAS}`);

  if (process.platform === "darwin") {
    const iconset = path.join(resourcesDir, "icon.iconset");
    fs.mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        await sharp(square).resize(size * scale, size * scale).png()
          .toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`));
      }
    }
    const result = spawnSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", path.join(resourcesDir, "icon.icns")], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("macOS icon generation failed");
    fs.rmSync(iconset, { recursive: true });
  }

  const pngs = [];
  for (const size of SIZES) {
    pngs.push(await sharp(square).resize(size, size).png().toBuffer());
  }

  // ICO: 6-byte header, one 16-byte directory entry per image, then the PNGs.
  // A 256px entry stores 0 in its width/height bytes.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(SIZES.length, 4);

  let offset = 6 + SIZES.length * 16;
  const entries = SIZES.map((size, index) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(pngs[index].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += pngs[index].length;
    return entry;
  });

  const ico = Buffer.concat([header, ...entries, ...pngs]);
  fs.writeFileSync(path.join(resourcesDir, "icon.ico"), ico);
  console.log(`icon.ico ${SIZES.join(",")} — ${Math.round(ico.length / 1024)} KB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
