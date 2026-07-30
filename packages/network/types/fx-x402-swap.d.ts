export interface FxX402SwapSummary {
  schema: "versus-x402-atomic-swap";
  schemaVersion: 1;
  tradeId: `0x${string}`;
  status: string;
  requester: `0x${string}`;
  destinationAddress: `0x${string}`;
  sourceRefundAddress: `0x${string}`;
  sourceTransactionHash?: `0x${string}`;
  sourceBlockNumber?: number;
}

export class FxX402RequesterClient {
  constructor(options: Record<string, unknown>);
  execute(request: Record<string, unknown>): Promise<{
    tradeId: `0x${string}`;
    status: string;
    swap: FxX402SwapSummary;
    recoveryFile: string;
    endpointPaymentAuthorized: true;
    endpointPaymentSubmitted: true;
  }>;
}

export class FxX402SwapCoordinator {
  constructor(options: Record<string, unknown>);
  open(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  accept(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  settle(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  announceSourceLock(
    request: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  reveal(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(tradeId: string): FxX402SwapSummary;
  close(): void;
}

export class FxX402SwapStore {
  constructor(options?: { directory?: string | null });
}

export class FxX402SwapError extends Error {
  code: string;
}

export function createFxX402SwapHttpHandler(
  options: Record<string, unknown>
): (request: unknown, response: unknown) => Promise<boolean>;

export function x402SwapIntent(
  input: Record<string, unknown>
): Record<string, unknown>;
export function x402SwapCommitment(
  intent: Record<string, unknown>
): `0x${string}`;
