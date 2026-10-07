import { defineConfig } from "astro/config";

// SITE_URL and BASE_PATH are set by the GitHub Pages workflow.
// For a project site served at https://<user>.github.io/<repo>/, BASE_PATH is "/<repo>".
export default defineConfig({
  site: process.env.SITE_URL ?? "http://localhost:4321",
  base: process.env.BASE_PATH ?? "/",
  trailingSlash: "always",
  devToolbar: { enabled: false },
});
