// Audits the built site (dist/) against the upstream openai/math checkout.
// Deliberately independent of build-data.mjs: it reads the published HTML, and takes the
// family → manuscript mapping from overview.tex rather than CONTENTS.md, so a parsing bug
// in the builder cannot confirm itself.
//
// Usage: npm run build && UPSTREAM_DIR=../math node scripts/audit.mjs
import fs from "node:fs";
import path from "node:path";
import { parse } from "node-html-parser";
import * as yaml from "js-yaml";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const UP = path.resolve(ROOT, process.env.UPSTREAM_DIR ?? "../math");
const DIST = path.join(ROOT, "dist");
const PREFIX = "https://github.com/openai/math/";

const problems = [];
const checked = {};
const fail = (kind, where, detail) => problems.push({ kind, where, detail });
const count = (k, n = 1) => (checked[k] = (checked[k] ?? 0) + n);

const up = (p) => fs.readFileSync(path.join(UP, p), "utf8");
const page = (p) => parse(fs.readFileSync(path.join(DIST, p), "utf8"));
// Visible text with typeset math removed (KaTeX duplicates it as MathML + HTML).
const text = (el) => {
  const c = el.clone();
  c.querySelectorAll(".katex").forEach((k) => k.remove());
  return c.textContent.replace(/\s+/g, " ").trim();
};
const norm = (s) =>
  s
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// ---------- source of truth ----------

// overview.tex: family number, field, and the manuscript PDFs listed for it.
const families = new Map();
{
  let field = null;
  for (const line of up("overview.tex").split("\n")) {
    const sec = line.match(/^\\cataloguesection\{([^}]+)\}/);
    if (sec) field = sec[1];
    const e = line.match(/^\\resultentry\{(\d{3})\}/);
    if (e) {
      const pdfs = [...line.matchAll(/\\href\{https:\/\/github\.com\/openai\/math\/blob\/main\/(preprints\/[^}]+?\.pdf)\}/g)].map(
        (m) => decodeURIComponent(m[1])
      );
      families.set(e[1], { field, pdfs });
    }
  }
}

// CONTENTS.md: title per family; title + abstract per manuscript, keyed by PDF path.
const famTitle = new Map();
const msSource = new Map();
{
  const lines = up("CONTENTS.md").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(/^\*\*(\d{3})\.\s+(.+?)\.\*\*/);
    if (f) famTitle.set(f[1], f[2]);
    const m = lines[i].match(/^&emsp;\[(.+?)\]\((preprints\/[^\n]+?\.pdf)\)(.*)$/);
    if (m) {
      const abs = [];
      for (let j = i + 1; j < lines.length && !lines[j].startsWith("</td>"); j++) abs.push(lines[j]);
      msSource.set(m[2], { title: m[1], abstract: abs.join("\n").trim() });
    }
  }
}

// Plain-language fragments of a markdown/HTML source string: the words between math and markup.
const fragments = (src) =>
  src
    .replace(/\$`[\s\S]+?`\$/g, "\u0001")
    .replace(/\[((?:\[[^\]]*\]|[^\]])*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?(i|b|em|sup|sub)>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\*\*/g, "")
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, "$1$2")
    .split(/\u0001|\n+/)
    .map((s) => norm(s))
    .filter((s) => s.length >= 12);

const pagesFile = path.join(ROOT, "data/pages.json");
const pages = fs.existsSync(pagesFile) ? JSON.parse(fs.readFileSync(pagesFile, "utf8")) : {};

const leanDocs = new Set(fs.readdirSync(path.join(UP, "lean/docs")).map((f) => f.slice(0, 3)));
const fy = yaml.load(up("lean/formalization.yaml"));
const yamlPapers = new Set(fy.sources.map((s) => path.posix.normalize(path.posix.join("lean", s.id))));

// Which comparator challenges are described by some family's Lean doc?
const docComparators = new Set();
for (const n of leanDocs) {
  for (const m of up(`lean/docs/${n}.md`).matchAll(/ComparatorChallenges\/([A-Za-z0-9_]+)\./g)) docComparators.add(m[1]);
}

// ---------- 1. every family page ----------

for (const [num, src] of families) {
  const file = `family/${num}/index.html`;
  if (!fs.existsSync(path.join(DIST, file))) {
    fail("missing page", num, file);
    continue;
  }
  const doc = page(file);
  count("family pages");

  const h1 = norm(text(doc.querySelector("h1")));
  const want = norm(fragments(famTitle.get(num) ?? "").join(" "));
  if (want && !h1.includes(want.slice(0, 40))) fail("family title", num, `page "${h1}" vs source "${want}"`);

  const crumb = doc.querySelectorAll(".trail a").map((a) => a.textContent.trim());
  if (!crumb.includes(src.field)) fail("field", num, `breadcrumb ${JSON.stringify(crumb)} vs overview.tex "${src.field}"`);
  count("fields matched");

  // Lean stamp in the verification record iff OpenAI published lean/docs/NNN.md.
  const hasStamp = !!doc.querySelector(".record .stamp");
  if (hasStamp !== leanDocs.has(num)) fail("lean status", num, `stamp=${hasStamp}, lean/docs/${num}.md exists=${leanDocs.has(num)}`);
  count("lean statuses");

  // Manuscripts: same set of PDFs as overview.tex lists for this family.
  const sections = doc.querySelectorAll(".ms");
  const pagePdfs = sections.map((s) => s.querySelector("a[data-pdf]")?.getAttribute("data-pdf") ?? null);
  const a = [...pagePdfs].sort().join("\n");
  const b = [...src.pdfs].sort().join("\n");
  if (a !== b) fail("manuscript set", num, `page:\n  ${pagePdfs.join("\n  ")}\noverview.tex:\n  ${src.pdfs.join("\n  ")}`);
  count("manuscript sets");

  sections.forEach((sec, i) => {
    const pdf = pagePdfs[i];
    const ms = msSource.get(pdf);
    if (!ms) return fail("manuscript unknown", num, pdf);
    count("manuscripts");

    // Every plain-language fragment of the source abstract appears in this manuscript's section.
    const body = norm(text(sec));
    for (const frag of fragments(ms.abstract)) {
      count("abstract fragments");
      if (!body.includes(frag)) fail("abstract text", `${num} ${pdf}`, `missing: "${frag.slice(0, 90)}"`);
    }
    for (const frag of fragments(ms.title)) {
      if (!body.includes(frag)) fail("manuscript title", `${num} ${pdf}`, `missing: "${frag}"`);
    }

    // Date matches the preprint README.
    const dir = pdf.split("/").slice(0, 2).join("/");
    const readme = path.join(UP, dir, "README.md");
    if (fs.existsSync(readme)) {
      const d = fs.readFileSync(readme, "utf8").match(/\*\*Date:\*\*\s*(.+)/)?.[1];
      const shown = sec.querySelector(".ms-date")?.textContent.trim();
      if (d && new Date(`${d} UTC`).getTime() !== new Date(`${shown} UTC`).getTime())
        fail("date", `${num} ${pdf}`, `page "${shown}" vs README "${d}"`);
      count("dates");
    }

    // The reader page linked from this paper loads this same PDF from GitHub's raw host.
    const readHref = sec.querySelector("a[data-pdf]").getAttribute("href").replace(/^\/[^/]*\/?(?=read\/)/, "");
    const readFile = path.join(DIST, readHref.replace(/^\//, ""), "index.html");
    if (!fs.existsSync(readFile)) fail("reader page", `${num} ${pdf}`, `missing ${readHref}`);
    else {
      const r = page(path.relative(DIST, readFile)).querySelector(".reader");
      const raw = "https://raw.githubusercontent.com/openai/math/main/" + pdf.split("/").map(encodeURIComponent).join("/");
      if (r?.getAttribute("data-pdf-path") !== pdf || r?.getAttribute("data-pdf") !== raw)
        fail("reader page", `${num} ${pdf}`, `reader loads ${r?.getAttribute("data-pdf")}`);
      count("reader pages");
    }

    // Page count matches the PDF (counted by scripts/page-counts.mjs).
    const want = pages[pdf]?.pages;
    const shownPages = sec.querySelector(".ms-pages")?.textContent.trim();
    if (want && shownPages !== `${want} pages`) fail("page count", `${num} ${pdf}`, `page "${shownPages}" vs PDF ${want}`);
    if (want) count("page counts");

    // Papers OpenAI lists in formalization.yaml carry the stamp.
    if (yamlPapers.has(pdf)) {
      count("yaml-listed papers stamped");
      if (!sec.querySelector(".stamp")) fail("paper lean stamp", `${num} ${pdf}`, "listed in formalization.yaml, no stamp");
    }
  });
}

// ---------- 2. no page for a family that doesn't exist ----------

for (const d of fs.readdirSync(path.join(DIST, "family"))) {
  if (!families.has(d)) fail("extra page", d, "no such family in overview.tex");
}

// ---------- 3. formalizations not attributed to any family ----------

for (const r of fy.status?.main_results ?? []) {
  const name = path.basename(r.comparator_config).replace(/\.[a-z]+$/, "");
  count("formalized main results");
  if (!docComparators.has(name))
    fail("orphan formalization", name, `${r.declaration} has no lean/docs page, so no result shows it`);
}

// ---------- 4. every link into openai/math points at a real file ----------

// Use git's file list so this also works on a sparse checkout without the PDFs.
let upstreamFiles = null;
try {
  upstreamFiles = new Set(execSync("git ls-tree -r --name-only HEAD", { cwd: UP, maxBuffer: 1 << 28 }).toString().split("\n"));
} catch {}
const upstreamHas = (p) =>
  upstreamFiles ? upstreamFiles.has(p) || [...upstreamFiles].some((f) => f.startsWith(p.replace(/\/$/, "") + "/")) : fs.existsSync(path.join(UP, p));

const seen = new Set();
for (const f of fs.readdirSync(DIST, { recursive: true }).filter((f) => f.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(DIST, f), "utf8");
  if (html.includes("katex-error")) fail("math rendering", f, "KaTeX error on page");
  for (const m of html.matchAll(/(?:href|data-pdf)="https:\/\/(?:github\.com\/openai\/math\/(?:blob|tree)|raw\.githubusercontent\.com\/openai\/math)\/main\/([^"#]+)"/g)) {
    const p = decodeURIComponent(m[1].replace(/&amp;/g, "&"));
    if (seen.has(p)) continue;
    seen.add(p);
    count("upstream links");
    if (!upstreamHas(p)) fail("dead link", f, p);
  }
}

// ---------- 5. headline numbers ----------

const home = text(page("index.html").querySelector("main"));
const nFam = families.size;
const nMs = msSource.size;
for (const [label, n] of [
  ["results", nFam],
  ["manuscripts", nMs],
]) {
  if (!home.includes(`${n} ${label}`)) fail("home count", label, `expected "${n} ${label}" on the home page`);
}
// One card per manuscript, each showing that paper's own title, date, PDF and Lean status.
// A paper counts as formalized if formalization.yaml lists it or a lean/docs page names it.
const docPapers = new Set();
for (const n of leanDocs) {
  for (const m of up(`lean/docs/${n}.md`).matchAll(/\]\(\.\.\/\.\.\/(preprints\/[^\n]+?\.pdf)\)/g)) docPapers.add(m[1]);
}
const cards = page("index.html").querySelectorAll(".card");
if (cards.length !== nMs) fail("home cards", "index", `${cards.length} cards vs ${nMs} manuscripts`);
for (const card of cards) {
  const pdf = card.querySelector("a[data-pdf]")?.getAttribute("data-pdf") ?? "";
  const ms = msSource.get(pdf);
  if (!ms) {
    fail("home card", card.getAttribute("data-key"), `unknown PDF ${pdf}`);
    continue;
  }
  count("home cards");
  const num = card.getAttribute("data-key").slice(0, 3);
  if (!families.get(num)?.pdfs.includes(pdf)) fail("home card result", num, `${pdf} is not in result ${num} per overview.tex`);
  const body = norm(text(card));
  for (const frag of fragments(ms.title)) if (!body.includes(frag)) fail("home card title", num, `missing: "${frag}"`);
  const firstPara = ms.abstract.split(/\n\s*\n/)[0];
  const opening = fragments(firstPara)[0];
  if (opening && !body.includes(opening.slice(0, 60))) fail("home card abstract", `${num} ${pdf}`, `missing: "${opening.slice(0, 60)}"`);
  const cardPages = card.querySelector(".ms-pages")?.textContent.trim();
  if (pages[pdf] && cardPages !== `${pages[pdf].pages} pages`) fail("home card pages", `${num} ${pdf}`, `"${cardPages}" vs ${pages[pdf].pages}`);
  const want = yamlPapers.has(pdf) || docPapers.has(pdf);
  if (!!card.querySelector(".stamp") !== want) fail("home card stamp", `${num} ${pdf}`, `stamp=${!want}, expected ${want}`);
}

// ---------- report ----------

console.log("Checked:");
for (const [k, v] of Object.entries(checked)) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log(`\nSource: ${nFam} families, ${nMs} manuscripts, ${leanDocs.size} lean docs, ${yamlPapers.size} papers in formalization.yaml`);
if (!problems.length) {
  console.log("\nNo problems found.");
} else {
  const byKind = Object.groupBy(problems, (p) => p.kind);
  console.log(`\n${problems.length} problems:`);
  for (const [k, list] of Object.entries(byKind)) {
    console.log(`\n[${k}] ${list.length}`);
    for (const p of list.slice(0, 8)) console.log(`  ${p.where}: ${p.detail}`);
    if (list.length > 8) console.log(`  ... and ${list.length - 8} more`);
  }
  process.exitCode = 1;
}
