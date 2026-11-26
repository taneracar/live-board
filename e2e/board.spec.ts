import AxeBuilder from "@axe-core/playwright";
import { expect, test, devices, type Browser, type BrowserContext, type Page } from "@playwright/test";

// Every context is closed after its test, or open sockets pile up in the
// shared browser.
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
});

// Two separate browser contexts = two people with their own tabs and storage.
// Contexts made by hand don't inherit the project's device, so pass it on.
async function twoPeople(browser: Browser, contextOptions = {}) {
  const { defaultBrowserType: _, ...device } = devices[test.info().project.name === "phone" ? "Pixel 7" : "Desktop Chrome"];
  const pages: Page[] = [];
  for (const name of ["Ana Diaz", "Bo Kim"]) {
    const ctx = await browser.newContext({ ...device, ...contextOptions });
    opened.push(ctx);
    await ctx.addInitScript((n) => localStorage.setItem("lb.name", n), name);
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("status")).toHaveText("Live");
    pages.push(page);
  }
  return pages as [Page, Page];
}

const unique = (s: string) => `${s} ${Math.random().toString(36).slice(2, 7)}`;
const column = (page: Page, name: string) => page.getByRole("region", { name: new RegExp(`^${name}`) });
const card = (page: Page, title: string) => page.locator("[data-card]", { hasText: title });

async function addCard(page: Page, col: string, title: string) {
  await column(page, col).getByLabel(`New card in ${col}`).fill(title);
  await column(page, col).getByRole("button", { name: "Add" }).click();
}

test("a card added by one person appears for the other, and both see each other", async ({ browser }) => {
  const [ana, bo] = await twoPeople(browser);
  const title = unique("Ship release notes");
  await addCard(ana, "To do", title);
  await expect(card(ana, title)).toBeVisible();
  await expect(column(bo, "To do").locator("[data-card]", { hasText: title })).toBeVisible();
  await expect(bo.getByRole("list", { name: "People on this board" })).toContainText("Ana Diaz");
  await expect(ana.getByRole("list", { name: "People on this board" })).toContainText("Bo Kim");
});

test("keyboard move (Alt+Arrow) syncs and keeps focus on the card", async ({ browser }) => {
  const [ana, bo] = await twoPeople(browser);
  const title = unique("Keyboard card");
  await addCard(ana, "To do", title);
  await card(ana, title).focus();
  await ana.keyboard.press("Alt+ArrowRight");
  await expect(column(ana, "Doing").locator("[data-card]", { hasText: title })).toBeVisible();
  await expect(card(ana, title)).toBeFocused();
  await expect(column(bo, "Doing").locator("[data-card]", { hasText: title })).toBeVisible();
});

test("reorder with buttons is the same for both people", async ({ browser }) => {
  const [ana, bo] = await twoPeople(browser);
  const first = unique("First");
  const second = unique("Second");
  await addCard(ana, "Done", first);
  await addCard(ana, "Done", second);
  await card(ana, second).getByRole("button", { name: `Move ${second} up` }).click();
  const order = (p: Page) => column(p, "Done").locator("[data-card] .title").allTextContents();
  await expect.poll(async () => (await order(bo)).filter((t) => t === first || t === second)).toEqual([second, first]);
  expect((await order(ana)).filter((t) => t === first || t === second)).toEqual([second, first]);
});

test("presence shows who is editing a card", async ({ browser }) => {
  const [ana, bo] = await twoPeople(browser);
  const title = unique("Presence card");
  await addCard(ana, "To do", title);
  await card(ana, title).getByRole("button", { name: `Edit ${title}` }).click();
  await expect(card(bo, title)).toContainText("Ana Diaz is editing this");
  await ana.keyboard.press("Escape");
  await expect(card(bo, title)).not.toContainText("is editing");
});

test("concurrent rename: the second save is not silently lost, the person is told", async ({ browser }) => {
  const [ana, bo] = await twoPeople(browser);
  const title = unique("Contested");
  await addCard(ana, "To do", title);
  await expect(card(bo, title)).toBeVisible();

  const anas = unique("Ana's version");
  const bos = unique("Bo's version");

  await card(ana, title).getByRole("button", { name: `Edit ${title}` }).click();
  await ana.getByLabel("Card title").fill(anas);

  await card(bo, title).getByRole("button", { name: `Edit ${title}` }).click();
  await bo.getByLabel("Card title").fill(bos);
  await bo.getByLabel("Card title").press("Enter");
  await expect(bo.getByTestId("status")).toHaveText("Live"); // Bo's rename is committed

  await ana.getByLabel("Card title").press("Enter");
  await expect(ana.getByRole("alert")).toContainText(bos);
  await expect(ana.getByRole("alert")).toContainText(anas);
  await expect(card(ana, bos)).toBeVisible();
  await expect(card(bo, bos)).toBeVisible();
  await expect(card(ana, anas)).toHaveCount(0);
});

test("a dropped connection reconnects and the edit made meanwhile arrives once", async ({ browser }) => {
  const [ana, bo] = await twoPeople(browser);
  const title = unique("After the drop");
  await ana.getByRole("button", { name: "Simulate drop" }).click();
  await addCard(ana, "To do", title);
  await expect(card(ana, title)).toBeVisible();
  await expect(ana.getByTestId("status")).toHaveText("Live");
  await expect(card(bo, title)).toHaveCount(1);
});

test("drag and drop between columns", async ({ browser }, info) => {
  test.skip(info.project.name === "phone", "HTML5 drag and drop has no touch support; phones use the move buttons");
  const [ana, bo] = await twoPeople(browser);
  const title = unique("Dragged");
  await addCard(ana, "To do", title);
  await card(ana, title).dragTo(column(ana, "Done").locator(".cards"));
  await expect(column(bo, "Done").locator("[data-card]", { hasText: title })).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`no axe violations (${scheme})`, async ({ browser }) => {
    const [ana] = await twoPeople(browser, { colorScheme: scheme });
    await addCard(ana, "To do", unique("Axe card"));
    const results = await new AxeBuilder({ page: ana }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`)).toEqual([]);
  });
}

test("the page does not scroll sideways; columns do", async ({ browser }, info) => {
  const [ana] = await twoPeople(browser);
  await addCard(ana, "To do", unique("Width check with a fairly long title that has to wrap nicely on a phone"));
  const overflow = await ana.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await ana.screenshot({ path: `test-results/screens/${info.project.name}.png` });
});
