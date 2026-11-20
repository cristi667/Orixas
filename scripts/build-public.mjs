// Copiaza fisierele publice ale site-ului in public/ (servit de Worker / Cloudflare).
import { cp, mkdir, readdir, rm, copyFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "public");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const entries = await readdir(root, { withFileTypes: true });
const htmlFiles = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
  .map((entry) => entry.name);

for (const file of htmlFiles) {
  await copyFile(path.join(root, file), path.join(out, file));
}

await cp(path.join(root, "assets"), path.join(out, "assets"), { recursive: true });

console.log(`public/: ${htmlFiles.length} pagini HTML + assets/`);
