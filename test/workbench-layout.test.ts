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
  expect(css.slice(desktopStart)).toContain(
    "grid-template-columns: var(--sidebar) minmax(0, 1fr)",
  );
});

test("mobile navigation exposes state and supports dismissal", async () => {
  const [html, app] = await Promise.all([
    readFile(join(publicRoot, "index.html"), "utf8"),
    readFile(join(publicRoot, "app.js"), "utf8"),
  ]);

  expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
  expect(html).toContain('href="styles.css?v=repository-mobile-v1"');
  expect(html).toContain('src="app.js?v=repository-mobile-v1"');
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
