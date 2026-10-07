// Records the page count of every manuscript PDF in data/pages.json.
// Entries are keyed by path and carry the PDF's git blob id, so a PDF that OpenAI
// replaces is counted again. PDFs missing from the checkout (the CI checkout is sparse)
// are downloaded from GitHub; only new or changed ones are fetched.
//
// Usage: UPSTREAM_DIR=../math node scripts/page-counts.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { PDFDocument } from "pdf-lib";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const UP = path.resolve(ROOT, process.env.UPSTREAM_DIR ?? "../math");
const OUT = path.join(ROOT, "data/pages.json");
const RAW = "https://raw.githubusercontent.com/openai/math/main/";

const known = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};

const wanted = new Set(
  [...fs.readFileSync(path.join(UP, "CONTENTS.md"), "utf8").matchAll(/\]\((preprints\/[^\n]+?\.pdf)\)/g)].map((m) => m[1])
);

// Blob id of every PDF at the checked-out commit, available even when the file itself isn't.
const blob = new Map(
  execSync("git ls-tree -r HEAD --format='%(objectname) %(path)' -- preprints", { cwd: UP, maxBuffer: 1 << 26 })
    .toString()
    .trim()
    .split("\n")
    .map((line) => [line.slice(41), line.slice(0, 40)])
);

async function count(p) {
  const local = path.join(UP, p);
  const bytes = fs.existsSync(local)
    ? fs.readFileSync(local)
    : Buffer.from(await (await fetch(RAW + p.split("/").map(encodeURIComponent).join("/"))).arrayBuffer());
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

const result = {};
let reused = 0;
const failed = [];
for (const p of [...wanted].sort()) {
  const sha = blob.get(p);
  if (known[p] && known[p].sha === sha) {
    result[p] = known[p];
    reused++;
    continue;
  }
  try {
    result[p] = { sha, pages: await count(p) };
  } catch (e) {
    failed.push(`${p}: ${e.message}`);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
const counted = Object.keys(result).length - reused;
console.log(`${Object.keys(result).length} PDFs: ${reused} unchanged, ${counted} counted, ${failed.length} failed`);
for (const f of failed) console.warn(`  could not count ${f}`);
