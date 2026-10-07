import { catalogue } from "../lib/data";

// Plain-text index for the catalogue search: one entry per manuscript, covering its
// result number, field, title and abstract. Keys match the cards' data-key.
export function GET() {
  const index = catalogue.families.flatMap((f) =>
    f.manuscripts.map((m, i) => ({
      n: `${f.num}-${i + 1}`,
      t: [f.num, f.field, m.titleText, m.abstractText].join(" ").toLowerCase(),
    }))
  );
  return new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json" } });
}
