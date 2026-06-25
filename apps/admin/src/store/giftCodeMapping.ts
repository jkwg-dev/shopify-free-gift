import type { ScopedGiftDiscountInput } from '@free-gift-engine/shopify';
import type { GiftCodeMapping, MintingKey } from '../domain.js';
import {
  DuplicateDiscountCodeError,
  UniqueKeyViolationError,
  type GiftCodeMappingTable,
  type ShopifyDiscountGateway,
} from '../ports.js';
import { generateOpaqueCode } from '../security/opaqueCode.js';

// Everything needed to mint the discount EXCEPT the code (the store generates that).
export type GiftDiscountSpec = Omit<ScopedGiftDiscountInput, 'code'>;

export type GiftCodeMappingStoreOptions = {
  readonly generateCode?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  // Regeneration attempts on the astronomically rare duplicate-code collision.
  readonly maxCodeAttempts?: number;
  // Polls a loser waits for the winner to publish the code.
  readonly maxWaitAttempts?: number;
  readonly waitIntervalMs?: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Idempotent, concurrency-safe get-or-create for the reusable gift code. Two concurrent calls for
// the same key yield exactly ONE Shopify discount: the unique key arbitrates which caller mints,
// and the other waits for and reuses that caller's code. Shopify is NEVER called before the key
// is reserved.
export class GiftCodeMappingStore {
  private readonly generateCode: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxCodeAttempts: number;
  private readonly maxWaitAttempts: number;
  private readonly waitIntervalMs: number;

  constructor(
    private readonly table: GiftCodeMappingTable,
    private readonly gateway: ShopifyDiscountGateway,
    options: GiftCodeMappingStoreOptions = {},
  ) {
    this.generateCode = options.generateCode ?? generateOpaqueCode;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxCodeAttempts = options.maxCodeAttempts ?? 5;
    this.maxWaitAttempts = options.maxWaitAttempts ?? 50;
    this.waitIntervalMs = options.waitIntervalMs ?? 20;
  }

  async getOrCreate(key: MintingKey, spec: GiftDiscountSpec): Promise<GiftCodeMapping> {
    const existing = await this.table.findByKey(key);
    if (existing !== null && existing.active && existing.code !== null) {
      return existing;
    }

    // Reserve the key first. If another caller already reserved it, we are the loser: wait for
    // their code rather than minting a second discount.
    let reservation: GiftCodeMapping;
    try {
      reservation = await this.table.insertPending(key);
    } catch (err) {
      if (err instanceof UniqueKeyViolationError) {
        return this.awaitResolved(key);
      }
      throw err;
    }

    // We won the race — only we call Shopify.
    try {
      const created = await this.mintWithRetry(spec);
      return await this.table.finalize(reservation.id, created);
    } catch (err) {
      // Minting failed: release the reservation so a later call can retry from a clean slate.
      await this.table.deletePending(reservation.id);
      throw err;
    }
  }

  private async mintWithRetry(
    spec: GiftDiscountSpec,
  ): Promise<{ code: string; discountId: string }> {
    for (let attempt = 1; ; attempt += 1) {
      const code = this.generateCode();
      try {
        return await this.gateway.createScopedGiftDiscount({ ...spec, code });
      } catch (err) {
        if (err instanceof DuplicateDiscountCodeError && attempt < this.maxCodeAttempts) {
          continue;
        }
        throw err;
      }
    }
  }

  private async awaitResolved(key: MintingKey): Promise<GiftCodeMapping> {
    for (let attempt = 0; attempt < this.maxWaitAttempts; attempt += 1) {
      const row = await this.table.findByKey(key);
      if (row !== null && row.active && row.code !== null) {
        return row;
      }
      await this.sleep(this.waitIntervalMs);
    }
    throw new Error('Timed out waiting for a concurrent gift-code creation to resolve');
  }
}
