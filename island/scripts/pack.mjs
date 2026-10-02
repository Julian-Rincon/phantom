// Copies the AppImage and .deb Tauri builds into release/, with the name
// they ship under. Used by `npm run pack` and by the release workflow.
//
// Linux replacement for the old NSIS/.exe packer — `tauri.conf.json`'s
// bundle targets are now ["appimage", "deb"] (see BRIDGE.md history / the
// Linux-port task notes), and there is no `windows/` nsis hooks directory
// to involve.

import { readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = join(root, "target", "release", "bundle");
const outDir = join(root, "release");

const { version } = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));

function newestMatching(dir, predicate) {
  let entries = [];
  try {
    entries = readdirSync(dir).filter(predicate);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  return entries.map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

mkdirSync(outDir, { recursive: true });

const appimage = newestMatching(join(bundleRoot, "appimage"), (f) => f.endsWith(".AppImage"));
const deb = newestMatching(join(bundleRoot, "deb"), (f) => f.endsWith(".deb"));

if (!appimage && !deb) {
  console.error(`No AppImage or .deb found under ${bundleRoot} — run \`npm run tauri build\` first.`);
  process.exit(1);
}

const copies = [];
if (appimage) {
  const dest = join(outDir, `PhantomIsland-${version}.AppImage`);
  copyFileSync(appimage, dest);
  copies.push(dest);
}
if (deb) {
  const dest = join(outDir, `phantom-island_${version}_amd64.deb`);
  copyFileSync(deb, dest);
  copies.push(dest);
}

console.log("\n  Build artifacts ready:\n");
for (const path of copies) {
  const mb = (statSync(path).size / 1024 / 1024).toFixed(2);
  console.log(`  ${path}  (${mb} MB)`);
}
console.log("");
