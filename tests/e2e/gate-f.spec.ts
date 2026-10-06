import { expect, test, type Page } from "@playwright/test";

const cleanMockAccount = "0x1111111111111111111111111111111111111111";
const agentSource = `machine AgentApproval {
  states IDLE, REQUESTED, APPROVED, USED;
  initial IDLE;
  inputs request, approve, execute, cancel, human_ok, scope_ok;
  outputs permit;
  terminal USED;
  reset_on cancel;

  IDLE -> REQUESTED when request;
  REQUESTED -> APPROVED when approve && human_ok && scope_ok;
  APPROVED -> USED when execute && human_ok && scope_ok emit permit;
}`;

async function installMockOkx(page: Page, initialChain = "0xc4"): Promise<void> {
  await page.addInitScript(({ account, chain }) => {
    let activeChain = chain;
    let activeAccounts: string[] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const provider = {
      isOkxWallet: true,
      request: async ({ method }: { method: string }) => {
        if (method === "eth_chainId") return activeChain;
        if (method === "eth_accounts") return activeAccounts;
        if (method === "eth_requestAccounts") { activeAccounts = [account]; return activeAccounts; }
        throw new Error(`Unexpected test wallet method: ${method}`);
      },
      on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); }
    };
    (window as unknown as { okxwallet: typeof provider; ethereum: { request: () => Promise<string> }; __gatexE2eWallet: unknown }).okxwallet = provider;
    (window as unknown as { ethereum: { request: () => Promise<string> } }).ethereum = { request: async () => "0x1" };
    (window as unknown as { __gatexE2eWallet: unknown }).__gatexE2eWallet = {
      setChain: (next: string) => { activeChain = next; listeners.get("chainChanged")?.(next); },
      setAccounts: (next: string[]) => { activeAccounts = next; listeners.get("accountsChanged")?.(next); },
      accounts: () => activeAccounts
    };
  }, { account: cleanMockAccount, chain: initialChain });
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/#/workspace");
  await expect(page.getByRole("heading", { name: "Compile. Inspect. Compare." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AgentApproval circuit 2" })).toBeVisible();
}

test("landing, workspace examples, editable DSL, diagnostics, and evidence routes", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.getByText("GateX turns human-readable application state machines into verified TapeOut NAND/LATCH circuits on X Layer.")).toBeVisible();
  await page.getByRole("link", { name: /Open workspace/ }).click();
  await openWorkspace(page);

  await expect(page.getByRole("complementary").getByText("98", { exact: true })).toBeVisible();
  await expect(page.getByText("2", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "TinyApproval circuit 1" }).click();
  await expect(page.getByRole("heading", { name: "TinyApproval circuit 1" })).toBeVisible();
  await expect(page.getByRole("complementary").getByText("89", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "AgentApproval circuit 2" }).click();
  await expect(page.getByRole("heading", { name: "AgentApproval circuit 2" })).toBeVisible();

  const editor = page.getByRole("textbox", { name: "GateX DSL source" });
  await editor.fill(`${agentSource}\n`);
  await expect(page.getByText("DETERMINISTIC", { exact: true })).toBeVisible();
  await editor.fill("machine Broken { states ONLY; initial ONLY; inputs request; outputs permit; }");
  await expect(page.getByText("COMPILER DIAGNOSTICS", { exact: false })).toBeVisible();
  await expect(page.getByText("BLOCKED", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Evidence" }).click();
  await expect(page.getByRole("heading", { name: "What has been proven." })).toBeVisible();
  await expect(page.getByText("circuit 1", { exact: true })).toBeVisible();
  await expect(page.getByText("circuit 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /0xf8fca87f…0816a8be/ })).toBeVisible();
});

test("read-only live comparison, stale quote, session restore, and source invalidation", async ({ page }) => {
  await openWorkspace(page);
  await page.getByRole("button", { name: "Refresh locked quote" }).click();
  await expect(page.getByText("Both locked providers agree", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("fixed mint fee / tx", { exact: true })).toBeVisible();
  await expect(page.getByText("wallet balance", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run live read ↗" }).click();
  await expect(page.getByText("MATCH", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Providers: https://rpc.xlayer.tech · https://xlayer.drpc.org", { exact: false })).toBeVisible();
  const staleQuote = page.getByText("Quote is stale. Refresh before relying on it.", { exact: true });
  if (!(await staleQuote.isVisible())) {
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Run live read ↗" }).click();
    await expect(page.getByText("MATCH", { exact: true })).toBeVisible({ timeout: 30_000 });
  }
  await expect(staleQuote).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("LOCAL", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("LOCAL", { exact: true })).toBeVisible();
  await expect(page.getByText(/Restored history for circuit 2\. It is not fresh live evidence\./)).toBeVisible();

  const editor = page.getByRole("textbox", { name: "GateX DSL source" });
  await editor.fill(`${agentSource}\n// changed after binding`);
  await expect(page.getByText("Binding invalidated by source change.", { exact: true })).toBeVisible();
  await expect(page.getByText("LOCAL", { exact: true })).toHaveCount(0);
  await expect(page.getByText("No live result recorded", { exact: true })).toBeVisible();
});

test("wallet UX uses the explicit OKX provider and invalidates on network/account changes", async ({ page }) => {
  await installMockOkx(page);
  await openWorkspace(page);
  await expect(page.getByText("Wallet disconnected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect OKX Wallet" }).click();
  await expect(page.getByText("Wallet connected", { exact: true })).toBeVisible();
  await expect(page.getByText(/OKX Wallet · 0x1111…1111 · X Layer \/ 196/)).toBeVisible();

  await page.evaluate(() => (window as unknown as { __gatexE2eWallet: { setChain: (chain: string) => void } }).__gatexE2eWallet.setChain("0x1"));
  await expect(page.getByText("Wrong network", { exact: true })).toBeVisible();
  await expect(page.getByText("Readiness was invalidated.", { exact: false })).toBeVisible();

  await page.evaluate(() => (window as unknown as { __gatexE2eWallet: { setChain: (chain: string) => void } }).__gatexE2eWallet.setChain("0xc4"));
  await expect(page.getByText("Wallet connected", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __gatexE2eWallet: { setAccounts: (accounts: string[]) => void } }).__gatexE2eWallet.setAccounts([]));
  await expect(page.getByText("Wallet disconnected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect OKX Wallet" }).click();
  await expect(page.getByText("Wallet connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByText("Wallet disconnected", { exact: true })).toBeVisible();
});

test("fresh wallet-disconnected state, no fallback, keyboard labels, and responsive layout", async ({ page }) => {
  await openWorkspace(page);
  await expect(page.getByText("Wallet disconnected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect OKX Wallet" })).toBeDisabled();
  await expect(page.getByText("No fallback to local result", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "TinyApproval circuit 1" }).press("Enter");
  await expect(page.getByRole("heading", { name: "TinyApproval circuit 1" })).toBeVisible();
  await page.getByRole("button", { name: "AgentApproval circuit 2" }).press("Enter");
  await expect(page.getByRole("heading", { name: "AgentApproval circuit 2" })).toBeVisible();
  await expect(page.getByLabel("GateX DSL source")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "request" })).toBeVisible();

  const metrics = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    reducedMotionRule: Array.from(document.styleSheets).some((sheet) => {
      try { return Array.from(sheet.cssRules).some((rule) => rule.cssText.includes("prefers-reduced-motion")); } catch { return false; }
    })
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
  expect(metrics.reducedMotionRule).toBe(true);
});

for (const width of [320, 390, 1440]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const metrics = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
  });
}
