export interface Eip1193Provider {
  isOkxWallet?: boolean;
  providers?: Eip1193Provider[];
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export interface WalletState {
  status: "disconnected" | "ready" | "wrong-network" | "unavailable" | "account-empty";
  provider?: Eip1193Provider;
  name?: string;
  rdns?: string;
  account?: string;
  chainId?: string;
  error?: string;
}

interface Eip6963Announcement {
  info?: { name?: string; rdns?: string };
  provider?: Eip1193Provider;
}

function isOkx(provider: Eip1193Provider | undefined, info?: { name?: string; rdns?: string }): boolean {
  return provider?.isOkxWallet === true || info?.rdns === "com.okex.wallet" || info?.name?.toLowerCase().includes("okx") === true;
}

export function discoverOkxProvider(): WalletState {
  if (typeof window === "undefined") return { status: "unavailable", error: "Browser wallet APIs are unavailable." };
  const announcements = ((window as unknown as { __gatexEip6963?: Eip6963Announcement[] }).__gatexEip6963 ?? []);
  const announced = announcements.find((entry) => isOkx(entry.provider, entry.info));
  if (announced?.provider) return { status: "disconnected", provider: announced.provider, name: announced.info?.name ?? "OKX Wallet", rdns: announced.info?.rdns ?? "com.okex.wallet" };
  const legacy = (window as unknown as { okxwallet?: Eip1193Provider }).okxwallet;
  if (isOkx(legacy)) return { status: "disconnected", provider: legacy, name: "OKX Wallet", rdns: "com.okex.wallet" };
  const providers = (window as unknown as { ethereum?: Eip1193Provider }).ethereum?.providers ?? [];
  const specific = providers.find((provider) => isOkx(provider));
  if (specific) return { status: "disconnected", provider: specific, name: "OKX Wallet", rdns: "com.okex.wallet" };
  return { status: "unavailable", error: "A specifically identifiable OKX provider was not discovered. Generic window.ethereum is not accepted." };
}

export function installEip6963Discovery(): void {
  if (typeof window === "undefined") return;
  const target = window as unknown as { __gatexEip6963?: Eip6963Announcement[] };
  target.__gatexEip6963 = [];
  window.addEventListener("eip6963:announceProvider", (event) => {
    const detail = (event as CustomEvent<Eip6963Announcement>).detail;
    if (detail?.provider) target.__gatexEip6963?.push(detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export async function readWallet(providerState: WalletState): Promise<WalletState> {
  const provider = providerState.provider;
  if (!provider) return providerState;
  try {
    const [chainIdRaw, accountsRaw] = await Promise.all([provider.request({ method: "eth_chainId" }), provider.request({ method: "eth_accounts" })]);
    const chainId = typeof chainIdRaw === "string" ? chainIdRaw.toLowerCase() : "";
    const account = Array.isArray(accountsRaw) && typeof accountsRaw[0] === "string" ? accountsRaw[0] : undefined;
    return { ...providerState, chainId, account, status: chainId !== "0xc4" ? "wrong-network" : account === undefined ? "disconnected" : "ready", error: undefined };
  } catch (error) {
    return { ...providerState, status: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function requestOkxAccounts(providerState: WalletState): Promise<WalletState> {
  if (!providerState.provider) return providerState;
  try {
    const chainBefore = await providerState.provider.request({ method: "eth_chainId" });
    if (typeof chainBefore !== "string" || chainBefore.toLowerCase() !== "0xc4") return { ...providerState, status: "wrong-network", chainId: typeof chainBefore === "string" ? chainBefore.toLowerCase() : undefined, error: "OKX Wallet must be on X Layer / 196 before connecting." };
    const accounts = await providerState.provider.request({ method: "eth_requestAccounts" });
    const account = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : undefined;
    const after = await readWallet({ ...providerState, account });
    return account === undefined ? { ...after, status: "account-empty", error: "OKX Wallet returned no account after the user connection request." } : after;
  } catch (error) {
    return { ...providerState, status: "disconnected", error: error instanceof Error ? error.message : String(error) };
  }
}

export function bindProviderEvents(providerState: WalletState, onChange: (next: WalletState) => void): void {
  let current = providerState;
  const invalidateAndReread = async (next: WalletState): Promise<void> => {
    current = next;
    onChange(current);
    current = await readWallet(current);
    onChange(current);
  };
  providerState.provider?.on?.("accountsChanged", (...args) => {
    const account = Array.isArray(args[0]) && typeof args[0][0] === "string" ? args[0][0] : undefined;
    void invalidateAndReread({ ...current, account, status: "disconnected", error: undefined });
  });
  providerState.provider?.on?.("chainChanged", (...args) => {
    const chainId = typeof args[0] === "string" ? args[0].toLowerCase() : undefined;
    void invalidateAndReread({ ...current, chainId, status: "wrong-network", error: undefined });
  });
}

export function abbreviatedAccount(account: string | undefined): string { return account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "none"; }

/**
 * Explicit connection. Asks the wallet to show its account picker even when this site was approved before
 * (wallet_requestPermissions), then reads the account. Wallets without that method fall back to eth_requestAccounts.
 */
export async function connectOkx(providerState: WalletState): Promise<WalletState> {
  const provider = providerState.provider;
  if (!provider) return providerState;
  try {
    await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 4001 || code === "4001") return { ...providerState, account: undefined, status: "disconnected", error: "Connection cancelled in the wallet." };
  }
  return requestOkxAccounts(providerState);
}

/** Asks the wallet to forget this site, where supported. Never throws. */
export async function revokeOkx(providerState: WalletState): Promise<void> {
  try { await providerState.provider?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* not supported: the app still forgets the connection */ }
}
