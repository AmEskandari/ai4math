// Builds src/data/catalogue.json from a checkout of github.com/openai/math.
// Usage: UPSTREAM_DIR=../math node scripts/build-data.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import katex from "katex";
import { marked } from "marked";
import * as yaml from "js-yaml";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const UP = path.resolve(ROOT, process.env.UPSTREAM_DIR ?? "../math");
const REPO = "https://github.com/openai/math";
const BLOB = `${REPO}/blob/main/`;
const TREE = `${REPO}/tree/main/`;
// Raw file host: serves PDFs with CORS enabled, so the site's reader can load them.
const RAW = "https://raw.githubusercontent.com/openai/math/main/";
const OUT = path.join(ROOT, "src/data/catalogue.json");
// Page counts from scripts/page-counts.mjs, keyed by PDF path.
const PAGES_FILE = path.join(ROOT, "data/pages.json");
const pageCounts = fs.existsSync(PAGES_FILE) ? JSON.parse(fs.readFileSync(PAGES_FILE, "utf8")) : {};

const read = (p) => fs.readFileSync(path.join(UP, p), "utf8");
const exists = (p) => fs.existsSync(path.join(UP, p));

// ---------- math + markdown ----------

function tex(src, displayMode = false) {
  return katex.renderToString(src, { throwOnError: false, displayMode, strict: "ignore", output: "htmlAndMathml" });
}

// Replace math with placeholders, render markdown, then put the typeset math back.
// `style` is "backtick" for GitHub's $`...`$ syntax, "dollar" for $...$ / $$...$$.
function renderMd(text, { style = "backtick", block = false, from = "" } = {}) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = text;
  if (style === "backtick") {
    s = s.replace(/\$`([\s\S]+?)`\$/g, (_, m) => keep(tex(m)));
  } else {
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => keep(tex(m, true)));
    s = s.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, pre, m) => pre + keep(tex(m)));
  }
  let html = block ? marked.parse(s) : marked.parseInline(s);
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
  // Relative links point into the upstream repository.
  html = html.replace(/href="(?!https?:|#|mailto:)([^"]+)"/g, (_, href) => {
    const resolved = path.posix.normalize(path.posix.join(from, href));
    return `href="${BLOB}${resolved}"`;
  });
  return html.replace(/<a href="http/g, '<a rel="noopener" href="http');
}

// Plain text for search: drop tags, keep TeX source.
function plain(text) {
  return text
    .replace(/\$`([\s\S]+?)`\$/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, " ")
    .replace(/[*_\\{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Link "result 032", "results 032 and 045", etc. to family pages (relative to site base).
function linkResults(html) {
  return html.replace(/\b(results?)\s+((?:\d{3})(?:(?:,\s*|,?\s+and\s+|\s*–\s*)\d{3})*)/g, (_, word, list) =>
    `${word} ` + list.replace(/\d{3}/g, (n) => `<a class="xref" data-family="${n}" href="family/${n}/">${n}</a>`)
  );
}

// ---------- fields from overview.tex ----------

const fieldOf = {};
const fields = [];
{
  let current = null;
  for (const line of read("overview.tex").split("\n")) {
    const sec = line.match(/^\\cataloguesection\{([^}]+)\}\{(\d+)\}/);
    if (sec) {
      current = sec[1];
      fields.push(current);
      continue;
    }
    const entry = line.match(/^\\resultentry\{(\d{3})\}/);
    if (entry && current) fieldOf[entry[1]] = current;
  }
}

// ---------- Lean formalization catalogue + per-family scope docs ----------

const formalization = yaml.load(read("lean/formalization.yaml"));
const leanPapers = new Set(
  (formalization.sources ?? []).map((s) => path.posix.normalize(path.posix.join("lean", s.id)))
);
const leanReviewStatus = formalization.review?.status ?? null;

const leanDocs = {};
for (const f of fs.readdirSync(path.join(UP, "lean/docs"))) {
  const m = f.match(/^(\d{3})\.md$/);
  if (!m) continue;
  const rel = `lean/docs/${f}`;
  const src = read(rel);
  const scope = src.match(/## Scope\s*\n([\s\S]*?)(?=\n## |\s*$)/)?.[1]?.trim() ?? "";
  const table = src.match(/## Comparator links\s*\n([\s\S]*?)(?=\n## |\s*$)/)?.[1] ?? "";
  const statements = [...table.matchAll(/^\|\s*(.+?)\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|/gm)]
    .filter((r) => !/^-+$/.test(r[1]) && r[1] !== "Result")
    .map((r) => ({
      result: renderMd(r[1], { style: "dollar" }),
      file: r[2],
      url: BLOB + path.posix.normalize(path.posix.join("lean/docs", r[3])),
    }));
  for (const p of src.matchAll(/\]\((\.\.\/\.\.\/preprints\/[^\n]+?\.pdf)\)/g)) {
    leanPapers.add(path.posix.normalize(path.posix.join("lean/docs", p[1])));
  }
  leanDocs[m[1]] = {
    url: BLOB + rel,
    scopeHtml: renderMd(scope, { style: "dollar", block: true, from: "lean/docs" }),
    statements,
  };
}

// ---------- reasoning summaries from README ----------

const reasoning = {};
for (const m of read("README.md").matchAll(/^\|\s*(\d{3})\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|/gm)) {
  reasoning[m[1]] = { title: m[2], url: BLOB + m[3] };
}

// ---------- manuscripts + families from CONTENTS.md ----------

function manuscriptMeta(pdfPath) {
  const dir = pdfPath.split("/").slice(0, 2).join("/");
  const meta = { dir, sourceUrl: TREE + dir, date: null, bibtex: null };
  if (exists(`${dir}/README.md`)) {
    const r = read(`${dir}/README.md`);
    meta.date = r.match(/\*\*Date:\*\*\s*(.+)/)?.[1]?.trim() ?? null;
    meta.bibtex = r.match(/```bibtex\n([\s\S]*?)```/)?.[1]?.trim() ?? null;
  }
  if (!meta.date) {
    const d = dir.match(/([A-Z][a-z]+)-(\d{1,2})-(\d{4})$/);
    if (d) meta.date = `${d[1]} ${d[2]}, ${d[3]}`;
  }
  if (meta.date) {
    const d = new Date(`${meta.date} UTC`);
    if (!isNaN(d)) {
      meta.date = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
      meta.isoDate = d.toISOString().slice(0, 10);
    }
  }
  return meta;
}

const families = [];
const blocks = [...read("CONTENTS.md").matchAll(/<td>\s*\n([\s\S]*?)\n\s*<\/td>/g)].map((m) => m[1].trim());

for (const b of blocks) {
  const fam = b.match(/^\*\*(\d{3})\.\s+([\s\S]+?)\.\*\*\s*([\s\S]*)$/);
  if (fam) {
    const [, num, title, rest] = fam;
    const description = rest.replace(/\s*\(\[Lean\]\(lean\/docs\/\d{3}\.md\)\)\s*$/, "").trim();
    families.push({
      num,
      titleHtml: renderMd(title),
      titleText: plain(title),
      descriptionHtml: linkResults(renderMd(description)),
      descriptionText: plain(description),
      field: fieldOf[num] ?? "Unclassified",
      lean: leanDocs[num] ?? null,
      reasoning: reasoning[num] ?? null,
      manuscripts: [],
    });
    continue;
  }
  // Text after the link on the same line is a label such as "— secondary writeup".
  const ms = b.match(/^&emsp;\[([\s\S]+?)\]\((preprints\/[^\n]+?\.pdf)\)([^\n]*)\n?([\s\S]*)$/);
  if (ms) {
    const [, title, pdf, label, abstract] = ms;
    const fam = families.at(-1);
    if (!fam) throw new Error(`Manuscript before any family: ${title}`);
    const note = label.replace(/^\s*[—–-]\s*/, "").trim();
    fam.manuscripts.push({
      titleHtml: renderMd(title.trim()),
      titleText: plain(title),
      note: note || null,
      pdfUrl: BLOB + pdf,
      pdfPath: pdf,
      rawUrl: RAW + pdf.split("/").map(encodeURIComponent).join("/"),
      leanFormalized: leanPapers.has(path.posix.normalize(pdf)),
      abstractHtml: linkResults(renderMd(abstract.trim(), { block: true })),
      abstractText: plain(abstract),
      pages: pageCounts[pdf]?.pages ?? null,
      ...manuscriptMeta(pdf),
    });
  }
}

// ---------- checks + stats ----------

const manuscripts = families.flatMap((f) => f.manuscripts);
const missingField = families.filter((f) => f.field === "Unclassified").map((f) => f.num);
if (missingField.length) console.warn(`Families without a field: ${missingField.join(", ")}`);

const byField = fields.map((name) => {
  const fs_ = families.filter((f) => f.field === name);
  return {
    name,
    families: fs_.length,
    manuscripts: fs_.reduce((n, f) => n + f.manuscripts.length, 0),
    leanFamilies: fs_.filter((f) => f.lean).length,
  };
});

let upstreamCommit = null;
try {
  upstreamCommit = execSync("git rev-parse HEAD", { cwd: UP }).toString().trim();
} catch {}

const releaseDate = read("overview.tex").match(/\\hfill\s+([A-Z][a-z]+ \d{1,2}, \d{4})\\par/)?.[1] ?? null;

const catalogue = {
  generatedAt: new Date().toISOString(),
  releaseDate,
  upstream: { repo: REPO, commit: upstreamCommit, leanReviewStatus },
  stats: {
    families: families.length,
    manuscripts: manuscripts.length,
    leanFamilies: families.filter((f) => f.lean).length,
    leanManuscripts: manuscripts.filter((m) => m.leanFormalized).length,
    reasoningSummaries: Object.keys(reasoning).length,
    fields: fields.length,
  },
  fields: byField,
  families,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(catalogue));
console.log(catalogue.stats, `→ ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
