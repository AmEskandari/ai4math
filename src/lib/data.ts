import catalogue from "../data/catalogue.json";

export type Catalogue = typeof catalogue;
export type Family = Catalogue["families"][number];
export type Manuscript = Family["manuscripts"][number];

export { catalogue };

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const url = (p = "") => `${BASE}/${p.replace(/^\//, "")}`;

// Cross-references inside descriptions are written relative to the site root.
export const withBase = (html: string) => html.replace(/href="family\//g, `href="${url("family/")}`);

export const fieldSlug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

// 722 → "seven hundred twenty-two", as a typed title page would have it.
export function inWords(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + inWords(n % 100) : "");
  return inWords(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + inWords(n % 1000) : "");
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
