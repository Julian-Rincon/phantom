// Generates src-tauri/icons/ from the Phantom emblem artwork.
//
// The previous version of this script rasterised "Mochi" (Coucou's
// character) in pure JS — that artwork is not part of Coucou's MIT license
// and is not ours to keep (see README.md's attribution note), so it has
// been replaced outright rather than ported. Phantom Island uses Phantom's
// own emblem instead, via ImageMagick (`magick`) rather than a hand-rolled
// PNG encoder — there is no "drawn in code" character to preserve anymore.
//
//   node scripts/gen-icons.mjs [path/to/source.png]

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");
const defaultSource = resolve(root, "..", "codeg", "public", "phantom-emblem-512.png");
const source = process.argv[2] ? resolve(process.argv[2]) : defaultSource;

if (!existsSync(source)) {
  console.error(`Source artwork not found: ${source}`);
  console.error("Pass a path explicitly: node scripts/gen-icons.mjs <path>");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const sizes = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
];

for (const [name, size] of sizes) {
  const dest = join(outDir, name);
  try {
    // -alpha on + png:color-type=6 forces RGBA output — Tauri's icon loader
    // rejects an RGB (no alpha channel) PNG at compile time with "icon is
    // not RGBA", which a plain resize of an already-opaque source produces.
    execFileSync(
      "magick",
      [source, "-resize", `${size}x${size}`, "-alpha", "on", "-define", "png:color-type=6", dest],
      { stdio: "inherit" }
    );
  } catch (err) {
    console.error(`ImageMagick ("magick") failed or is not installed: ${err.message}`);
    process.exit(1);
  }
  console.log(`  wrote ${name} (${size}x${size})`);
}

console.log(`\nIcons regenerated from ${source}\n`);
