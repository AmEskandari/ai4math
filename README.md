# The Machine Manuscripts

An unofficial, searchable index of the mathematical manuscripts released by OpenAI at
[github.com/openai/math](https://github.com/openai/math), with the Lean formalization status of every result.

Not affiliated with OpenAI. The papers, proofs and formalizations belong to that repository (Apache License 2.0);
this site links to them and quotes their abstracts and formalization notes.

## Run locally

Needs Node 22 and a checkout of `openai/math` next to this folder (`../math`), or set `UPSTREAM_DIR`.

```sh
npm install
npm run dev        # builds src/data/catalogue.json, then serves http://localhost:4321
```

## How it works

- `scripts/build-data.mjs` reads `CONTENTS.md`, `overview.tex`, `lean/formalization.yaml`, `lean/docs/*.md` and each
  preprint's `README.md`, renders the math with KaTeX, and writes `src/data/catalogue.json`.
- `scripts/page-counts.mjs` records each PDF's page count in `data/pages.json`, counting only new or changed PDFs.
- Astro turns that into static pages: the catalogue, one page per result, the verification table, and a reader page
  per manuscript. The reader uses pdf.js to show the PDF straight from `raw.githubusercontent.com`, so the PDFs are
  never copied into this site.
- `.github/workflows/deploy.yml` rebuilds every three hours from the latest `openai/math` and deploys to GitHub Pages.

## Accuracy audit

`npm run audit` checks the built site against `openai/math`, independently of the builder: every result's title,
field and Lean status; every manuscript's title, abstract text, date and links; that each family lists exactly the
PDFs that `overview.tex` lists for it; and that every link into the upstream repository points at a real file.
The deploy workflow runs it on every build and does not deploy if it finds a problem.

## Deploy to GitHub Pages

1. Push this folder to a new GitHub repository.
2. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow runs on every push. The site appears at `https://<user>.github.io/<repo>/`.

Edit `src/config.ts` to set the site name, maintainer, and repository URL (the last enables "submit a review" links).
