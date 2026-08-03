import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const publicRoot = join(import.meta.dir, "../src/workbench/public");

test("Workbench layout is mobile-first with component and desktop enhancement", async () => {
  const css = await readFile(join(publicRoot, "styles.css"), "utf8");
  const desktopStart = css.indexOf("@media (min-width: 70rem)");
  const mobileShell = css.indexOf(".shell {\n  display: block;");

  expect(mobileShell).toBeGreaterThan(-1);
  expect(desktopStart).toBeGreaterThan(mobileShell);
  expect(css).toContain("container-type: inline-size");
  expect(css).toContain("@container (min-width: 34rem)");
  expect(css).toContain("@container (min-width: 62rem)");
  expect(css).toContain("@media (min-width: 48rem) and (max-width: 69.999rem)");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain("min-height: 44px");
  expect(css.slice(desktopStart)).toContain("grid-template-columns: var(--sidebar) minmax(0, 1fr)");
});

test("mobile navigation exposes state and supports dismissal", async () => {
  const [html, app] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
  ]);

  expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
  expect(html).toContain('href="styles.css?v=memory-lab-v1"');
  expect(html).toContain('src="app.js?v=memory-lab-v1"');
  expect(html).toContain('aria-controls="primary-sidebar"');
  expect(html).toContain('aria-expanded="false"');
  expect(app).toContain('window.matchMedia("(min-width: 70rem)")');
  expect(app).toContain('const wasOpen = sidebar.classList.contains("open")');
  expect(app).toContain("sidebar.inert");
  expect(app).toContain("page.inert = mobileOpen");
  expect(app).toContain('sidebar.setAttribute("aria-hidden"');
  expect(app).toContain("restoreFocus && wasOpen");
  expect(app).toContain('event.key === "Escape"');
  expect(app).toContain('!event.target.closest("#primary-sidebar")');
});

test("Memory Lab is a standalone mobile-first Foldkit surface", async () => {
  const appRoot = join(import.meta.dir, "../apps/workbench-web");
  const [html, main, css, config, memoryLab] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(appRoot, "src/main.ts"), "utf8"),
    readFile(join(appRoot, "src/styles.css"), "utf8"),
    readFile(join(appRoot, "vite.config.ts"), "utf8"),
    readFile(join(import.meta.dir, "../src/workbench/memory-lab.ts"), "utf8"),
  ]);

  expect(html).toContain('href="/memory/"');
  expect(html).not.toContain('id="view-memory"');
  expect(main).toContain('from "@foldkit/ui"');
  expect(main).toContain("Runtime.ApplicationInit");
  expect(main).toContain("Is the AI proposal correct?");
  expect(main).toContain("What was the outcome?");
  expect(main).toContain("Correction or feedback (optional)");
  expect(main).toContain("Note (optional)");
  expect(main).toContain("proposalSet");
  expect(main).toContain("data-[checked]:bg-primary");
  expect(main).not.toContain("data-[selected]:bg-primary");
  expect(memoryLab).toContain("operator-reviews.draft.json");
  expect(main).toContain("does not promote memory, run a model, or reveal source identities");
  expect(main).toContain("@min-[48rem]:grid-cols");
  expect(main).toContain('fetch("/api/memory-lab/draft"');
  expect(main).toContain('"X-Chatlog-Memory-Lab": "1"');
  expect(main).toContain('fetch("/api/memory-lab/finalize"');
  expect(css).toContain('@import "tailwindcss"');
  expect(css).toContain("@theme inline");
  expect(config).toContain('base: "/memory/"');
  expect(config).toContain('outDir: "../../src/workbench/public/memory"');
});
