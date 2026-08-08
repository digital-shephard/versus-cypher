import type { IncomingMessage, ServerResponse } from "node:http";

export interface FxX402ExactPreparedIntent {
  tradeId: string;
  network: `eip155:${string}`;
  asset: string;
  amount: string;
  payTo: string;
  payer?: string;
  maxTimeoutSeconds?: number;
  tokenName: string;
  tokenVersion: string;
  createdAt?: number;
  publicState?: Record<string, unknown>;
  privateState?: Record<string, unknown>;
}

export interface FxX402ExactCoordinatorOptions {
  prepare(body: Record<string, unknown>): Promise<FxX402ExactPreparedIntent>;
  settle(input: Record<string, unknown>): Promise<{
    transaction: string;
    publicState?: Record<string, unknown>;
  }>;
  reveal?(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  status?(state: Record<string, unknown>): Promise<Record<string, unknown>>;
  store?: FxX402ExactStore;
  now?: () => number;
}

export class FxX402ExactError extends Error {
  code: string;
}

export class FxX402ExactStore {
  constructor(options?: { directory?: string | null });
  getByRequest(key: string): Record<string, unknown> | null;
  get(tradeId: string): Record<string, unknown> | null;
  put(state: Record<string, unknown>): Record<string, unknown>;
  update(tradeId: string, patch: Record<string, unknown>): Record<string, unknown>;
}

export class FxX402ExactCoordinator {
  constructor(options: FxX402ExactCoordinatorOptions);
  prepare(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  settle(body: Record<string, unknown>, payment: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(tradeId: string): Promise<Record<string, unknown>>;
  reveal(tradeId: string, secret: string): Promise<Record<string, unknown>>;
  publicState(state: Record<string, unknown>): Record<string, unknown>;
}

export function createFxX402ExactHttpHandler(options: {
  coordinator: FxX402ExactCoordinator;
  resource?: string;
  publicUrl?: string;
}): (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

export function createEvmExactSettlementExecutor(options: {
  signerForNetwork(network: string): Promise<unknown> | unknown;
  confirmations?: number;
}): (input: Record<string, unknown>) => Promise<{
  transaction: string;
  publicState: Record<string, unknown>;
}>;
