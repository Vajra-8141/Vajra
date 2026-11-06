/**
 * What the wallet does with a dapp's request, with the browser taken out so that it can be tested on its own. background.ts supplies
 * the browser.
 *
 * The account's address is what a dapp sees. The key behind it is the daily key, so all a site can get from this wallet is a payment
 * through the rulebook, after the owner has read it. A signature over anything else is refused: this account has no ERC-1271, so a
 * message signed by the daily key would prove nothing about the account.
 */
import type { Address, Hex } from "viem";
import { type Book, type Warning, labelOf, recipientWarnings, shortAddress } from "@vajra/shared/addressbook";
import { type Payment, ProviderError, ProviderErrors, type TxRequest, paymentFrom } from "@vajra/shared/request";
import type { Forecast } from "@vajra/shared/review";

export interface ConnectApproval {
  kind: "connect";
  origin: string;
  account: Address;
}

export interface PaymentApproval {
  kind: "payment";
  origin: string;
  account: Address;
  recipient: Address;
  label: string | null;
  amountText: string;
  warnings: Warning[];
  forecast: Forecast;
}

export type Approval = ConnectApproval | PaymentApproval;

export interface Deps {
  chainId: number;
  account(): Promise<Address | null>;
  isConnected(origin: string): Promise<boolean>;
  setConnected(origin: string, connected: boolean): Promise<void>;
  book(): Promise<Book>;
  /** Resolves true or false. A closed window is a false. */
  approve(request: Approval): Promise<boolean>;
  forecast(account: Address, payment: Payment): Promise<Forecast>;
  amountText(payment: Payment): Promise<string>;
  /** Signs and hands to the alt mempool, and returns the hash once it is admitted. */
  send(account: Address, payment: Payment): Promise<Hex>;
  rpc(method: string, params: unknown[]): Promise<unknown>;
  emit(origin: string, event: string, payload: unknown): void;
}

/** Reads a dapp may make, passed to the node as they are. Nothing that can write is in this list. */
const READS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "web3_clientVersion",
]);

const SIGNING = new Set(["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4"]);

const hexChain = (id: number) => `0x${id.toString(16)}`;

export async function handle(deps: Deps, origin: string, method: string, params: unknown[] = []): Promise<unknown> {
  const connectedAccounts = async () => {
    const account = await deps.account();
    return account && (await deps.isConnected(origin)) ? [account] : [];
  };

  switch (method) {
    case "eth_chainId":
      return hexChain(deps.chainId);
    case "net_version":
      return String(deps.chainId);
    case "eth_accounts":
      return connectedAccounts();
    case "eth_requestAccounts": {
      const account = await deps.account();
      if (!account) throw new ProviderError(ProviderErrors.unauthorized, "No VAJRA account is set up. Open the extension first.");
      if (await deps.isConnected(origin)) return [account];
      if (!(await deps.approve({ kind: "connect", origin, account }))) throw new ProviderError(ProviderErrors.userRejected, "The owner refused the connection.");
      await deps.setConnected(origin, true);
      deps.emit(origin, "accountsChanged", [account]);
      return [account];
    }
    case "wallet_switchEthereumChain": {
      const wanted = (params[0] as { chainId?: string } | undefined)?.chainId;
      if (wanted?.toLowerCase() === hexChain(deps.chainId)) return null;
      throw new ProviderError(4902, `This wallet only knows chain ${deps.chainId}.`);
    }
    case "wallet_getPermissions":
      return (await connectedAccounts()).length ? [{ parentCapability: "eth_accounts" }] : [];
    case "wallet_requestPermissions":
      await handle(deps, origin, "eth_requestAccounts");
      return [{ parentCapability: "eth_accounts" }];
    case "wallet_revokePermissions":
      await deps.setConnected(origin, false);
      deps.emit(origin, "accountsChanged", []);
      return null;
    case "eth_sendTransaction":
      return pay(deps, origin, params[0] as TxRequest);
  }
  if (SIGNING.has(method)) throw new ProviderError(ProviderErrors.unsupported, "This account is a contract with no ERC-1271, so a message signed by its daily key would prove nothing. Refused.");
  if (READS.has(method)) return deps.rpc(method, params);
  throw new ProviderError(ProviderErrors.unsupported, `${method} is not supported.`);
}

async function pay(deps: Deps, origin: string, request: TxRequest): Promise<Hex> {
  const account = await deps.account();
  if (!account || !(await deps.isConnected(origin))) throw new ProviderError(ProviderErrors.unauthorized, "This site is not connected.");
  return askAndSend(deps, origin, account, paymentFrom(request ?? {}, account));
}

/** The one road to a signature, for a dapp and for the popup alike. */
export async function askAndSend(deps: Deps, origin: string, account: Address, payment: Payment): Promise<Hex> {
  const [book, forecast, amountText] = await Promise.all([deps.book(), deps.forecast(account, payment), deps.amountText(payment)]);
  const approved = await deps.approve({
    kind: "payment",
    origin,
    account,
    recipient: payment.recipient,
    label: labelOf(book, payment.recipient),
    amountText,
    warnings: recipientWarnings(book, payment.recipient, forecast.seenBefore),
    forecast,
  });
  if (!approved) throw new ProviderError(ProviderErrors.userRejected, "The owner refused the payment.");
  if (forecast.outcome === "refused") throw new ProviderError(ProviderErrors.unsupported, forecast.text);
  return deps.send(account, payment);
}

export const describeApproval = (a: Approval) => (a.kind === "connect" ? `${a.origin} asks to see this account` : `Pay ${a.amountText} to ${a.label ?? shortAddress(a.recipient)}`);
