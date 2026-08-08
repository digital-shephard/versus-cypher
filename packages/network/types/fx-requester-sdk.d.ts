export interface WalletSigner {
  getAddress(): Promise<string>;
  signMessage(message: string | Uint8Array): Promise<string>;
}

export interface X402FundingRequirement {
  x402Version?: number;
  scheme: string;
  network: `eip155:${string}`;
  asset: string;
  amount: string;
  [key: string]: unknown;
}

export interface FundingInputOption {
  chainId: string | number | bigint;
  token: string;
  maxInputAtomic: string | number | bigint;
}

export interface FundsReadyReceipt {
  schema: "versus-fx-funds-ready";
  schemaVersion: 1;
  status: "funds_ready";
  tradeId: string;
  proposalId: string;
  requester: string;
  destinationAddress: string;
  outputChainId: string;
  outputToken: string;
  requiredAmountAtomic: string;
  observedAmountAtomic: string;
  destinationTransactionHash: string;
  destinationBlockNumber: string;
  confirmations: number;
  confirmedAt: number;
  endpointPaymentAuthorized: false;
  endpointPaymentSubmitted: false;
  receiptId: string;
}

export interface FxRequesterFundingSdkOptions {
  deploymentId: string;
  signer: WalletSigner;
  brokerEndpoints: string[];
  recoveryDirectory: string;
  settlementExecutor(input: Record<string, unknown>): Promise<unknown>;
  destinationVerifier(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  queryRoutes?(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  now?(): number;
  randomSecret?(): Uint8Array;
}

export class FxRequesterFundingSdk {
  constructor(options: FxRequesterFundingSdkOptions);
  quoteFunding(input: {
    requirement: X402FundingRequirement | { accepts: X402FundingRequirement[] };
    destinationAddress: string;
    inputOptions: FundingInputOption[];
    tradeId?: string;
    quoteLifetimeSeconds?: number;
    settlementLifetimeSeconds?: number;
    quotePolicy?: string;
    timeoutMs?: number;
    inputChainId?: string | number | bigint;
    inputToken?: string;
  }): Promise<Record<string, unknown>>;
  executeFunding(input: {
    quote: Record<string, unknown>;
    recoveryPassword: string;
    ownerApproved: true;
  }): Promise<{
    fundsReady: true;
    receipt: FundsReadyReceipt;
    recoveryFile: string;
    endpointPaymentAuthorized: false;
  }>;
  recoverFunding(input: {
    quote: Record<string, unknown>;
    recoveryPassword: string;
    settlement: unknown;
  }): Promise<{
    fundsReady: true;
    receipt: FundsReadyReceipt;
    recoveryFile: string;
    endpointPaymentAuthorized: false;
  }>;
}

export class FxRequesterSdkError extends Error {
  code: string;
}

export function parseX402FundingRequirement(
  input: X402FundingRequirement | { accepts: X402FundingRequirement[] }
): Record<string, unknown>;

export function parseX402PaymentRequiredHeader(value: string): Record<string, unknown>;
