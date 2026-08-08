import type { FxX402ExactStore } from "./fx-x402-exact";

export interface FxX402ExactFactoryConfig {
  factoryAddress: string;
  tokenName: string;
  tokenVersion: string;
  facilitatorRecipient: string;
  facilitatorFeeAtomic: string;
}

export class FxX402ExactBrokerBridge {
  constructor(options: {
    broker: { requestRoute(rfq: Record<string, unknown>): Promise<Record<string, unknown>> };
    session: Record<string, unknown>;
    manifest: Record<string, unknown>;
    providers: Map<string, unknown> | Record<string, unknown>;
    factories: Map<string, FxX402ExactFactoryConfig> | Record<string, FxX402ExactFactoryConfig>;
    signerForNetwork(network: string): Promise<unknown> | unknown;
    store?: FxX402ExactStore;
    now?: () => number;
    quoteLifetimeSeconds?: number;
    settlementLifetimeSeconds?: number;
    reservationTimeoutMs?: number;
    confirmations?: number;
  });
  coordinator: Record<string, unknown>;
  prepare(body: Record<string, unknown>): Promise<Record<string, unknown>>;
  settle(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(state: Record<string, unknown>): Promise<Record<string, unknown>>;
  reveal(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function normalizeGenericIntent(body: Record<string, unknown>): Record<string, string>;
export function packSettlement(refundTimestamp: number, beneficiaryAmountAtomic: string): bigint;
