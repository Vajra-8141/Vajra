/**
 * What a dapp's eth_sendTransaction can become.
 *
 * The daily key has exactly one way to move value, `spend(asset, recipient, amount)`, and `validateDaily` refuses everything else.
 * So a plain ETH payment and an ERC-20 `transfer` can be carried out, and any other call cannot. That is the rulebook working, not
 * a gap in the extension, and the error says so rather than failing later in a mempool.
 */
import { type Address, type Hex, decodeFunctionData, getAddress, isAddress, parseAbi, zeroAddress } from "viem";

/** EIP-1193 codes. */
export const ProviderErrors = { userRejected: 4001, unauthorized: 4100, unsupported: 4200, disconnected: 4900, chainDisconnected: 4901 } as const;

export class ProviderError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export interface TxRequest {
  from?: string;
  to?: string | null;
  value?: string;
  data?: string;
  input?: string;
}

export interface Payment {
  asset: Address;
  recipient: Address;
  amount: bigint;
}

const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

const NOT_A_PAYMENT = "The daily key can only pay: ETH, or an ERC-20 transfer. A contract call like this one needs the master key, so it is refused here.";

export function paymentFrom(request: TxRequest, account: Address): Payment {
  if (request.from && request.from.toLowerCase() !== account.toLowerCase()) throw new ProviderError(ProviderErrors.unauthorized, `this wallet only sends from ${account}`);
  if (!request.to) throw new ProviderError(ProviderErrors.unsupported, "The daily key cannot deploy a contract.");
  if (!isAddress(request.to, { strict: false })) throw new ProviderError(ProviderErrors.unsupported, `not an address: ${request.to}`);
  const to = getAddress(request.to);
  const value = BigInt(request.value ?? "0x0");
  const data = (request.data ?? request.input ?? "0x") as Hex;
  if (data === "0x") return { asset: zeroAddress, recipient: to, amount: value };
  if (value !== 0n) throw new ProviderError(ProviderErrors.unsupported, NOT_A_PAYMENT);
  try {
    const { args } = decodeFunctionData({ abi: erc20, data });
    return { asset: to, recipient: args[0], amount: args[1] };
  } catch {
    throw new ProviderError(ProviderErrors.unsupported, NOT_A_PAYMENT);
  }
}
