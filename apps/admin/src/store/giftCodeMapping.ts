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
  readonly now?: () => Date;
  // Regeneration attempts on the astronomically rare duplicate-code collision.
  readonly maxCodeAttempts?: number;
  // Polls a loser waits for the winner to publish the code (one wait window).
  readonly maxWaitAttempts?: number;
  readonly waitIntervalMs?: number;
  // How many times we re-evaluate the reservation (wait → take over → reclaim) before giving up.
  readonly maxTakeoverRounds?: number;
  // A pending reservation older than this is treated as ABANDONED (its holder died mid-flight, e.g.
  // a killed serverless invocation) and may be reclaimed. Must exceed a normal mint's duration so we
  // never reclaim a reservation whose holder is still legitimately minting.
  readonly staleReservationMs?: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Idempotent, concurrency-safe get-or-create for the reusable gift code. Two concurrent calls for
// the same key yield exactly ONE Shopify discount: the unique key arbitrates which caller mints,
// and the other waits for and reuses that caller's code. Shopify is NEVER called before the key
// is reserved.
//
// Reservation lifecycle is fail-safe: a reservation NEVER outlives a failed mint, and an abandoned
// reservation (holder killed mid-flight, or a pre-existing zombie) cannot permanently wedge the key.
// A waiter that sees the holder fail/abandon takes over and re-mints — so the caller surfaces the
// REAL minting error (e.g. EmptyQualifyingScopeError) instead of a generic concurrency timeout.
export class GiftCodeMappingStore {
  private readonly generateCode: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly maxCodeAttempts: number;
  private readonly maxWaitAttempts: number;
  private readonly waitIntervalMs: number;
  private readonly maxTakeoverRounds: number;
  private readonly staleReservationMs: number;

  constructor(
    private readonly table: GiftCodeMappingTable,
    private readonly gateway: ShopifyDiscountGateway,
    options: GiftCodeMappingStoreOptions = {},
  ) {
    this.generateCode = options.generateCode ?? generateOpaqueCode;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
    this.maxCodeAttempts = options.maxCodeAttempts ?? 5;
    this.maxWaitAttempts = options.maxWaitAttempts ?? 50;
    this.waitIntervalMs = options.waitIntervalMs ?? 20;
    this.maxTakeoverRounds = options.maxTakeoverRounds ?? 4;
    this.staleReservationMs = options.staleReservationMs ?? 60_000;
  }

  async getOrCreate(key: MintingKey, spec: GiftDiscountSpec): Promise<GiftCodeMapping> {
    for (let round = 0; round < this.maxTakeoverRounds; round += 1) {
      const existing = await this.table.findByKey(key);

      if (existing !== null && existing.active && existing.code !== null) {
        return existing; // already minted — reuse the stored code
      }

      if (
        existing !== null &&
        existing.active &&
        existing.code === null &&
        !this.isAbandoned(existing)
      ) {
        // A fresh, ACTIVE reservation is in progress: wait for the holder to publish (or fail).
        const resolved = await this.waitForHolder(key);
        if (resolved !== null) {
          return resolved;
        }
        continue; // holder released/abandoned mid-wait → re-evaluate and take over
      }

      if (existing !== null) {
        // Any other existing row is UNUSABLE for this key and must be reclaimed before we can mint:
        //   - an ABANDONED reservation (active, code null, holder died / went stale), or
        //   - an INACTIVE row (active === false) — a superseded/deactivated code that still occupies
        //     this exact key. It can never be reused (inactive) yet blocks insertPending on the
        //     unique key, so it permanently wedged getOrCreate into the timeout below.
        // Safe to delete: a live holder never owns these (a fresh active reservation took the wait
        // branch above; an inactive row's discount is already deactivated in Shopify). Best-effort —
        // a concurrent reclaimer may have removed it already.
        await this.releaseReservation(existing.id);
      }

      // Become the holder: reserve, then mint. Any mint failure releases the reservation.
      let reservation: GiftCodeMapping;
      try {
        reservation = await this.table.insertPending(key);
      } catch (err) {
        if (err instanceof UniqueKeyViolationError) {
          continue; // another caller reserved between our read and insert — loop to wait on them
        }
        throw err;
      }
      return await this.mintOrRelease(reservation, spec);
    }
    throw new Error('Timed out waiting for a concurrent gift-code creation to resolve');
  }

  // Mint as the reservation holder. ANY failure (empty scope, Shopify userError, exhausted code
  // retries) releases the reservation BEFORE the error propagates, so a failed mint never wedges the
  // key and the caller sees the real cause.
  private async mintOrRelease(
    reservation: GiftCodeMapping,
    spec: GiftDiscountSpec,
  ): Promise<GiftCodeMapping> {
    try {
      const created = await this.mintWithRetry(spec);
      return await this.table.finalize(reservation.id, created);
    } catch (err) {
      await this.releaseReservation(reservation.id);
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

  // Wait one window for the holder to resolve the reservation. Returns the resolved mapping, or null
  // when the caller should take over: the holder RELEASED the row (failed mint → row gone) or the
  // reservation went STALE (holder died) while we waited. Distinguishing these from "still in
  // progress" is what stops a failed/abandoned holder from blocking us to a blind timeout.
  private async waitForHolder(key: MintingKey): Promise<GiftCodeMapping | null> {
    for (let attempt = 0; attempt < this.maxWaitAttempts; attempt += 1) {
      await this.sleep(this.waitIntervalMs);
      const row = await this.table.findByKey(key);
      if (row === null) {
        return null; // holder released on failure → we take over and surface the real error
      }
      if (row.active && row.code !== null) {
        return row; // holder published the code
      }
      if (this.isAbandoned(row)) {
        return null; // reservation went stale → we reclaim and take over
      }
    }
    return null; // window elapsed; the outer loop re-evaluates (reclaim if now stale, else retry)
  }

  // Best-effort release: tolerate an already-removed row (a concurrent reclaimer, or a cascade
  // delete from re-seeding the campaign) so releasing never throws over the real error.
  private async releaseReservation(id: string): Promise<void> {
    try {
      await this.table.deletePending(id);
    } catch {
      // already gone — nothing to release
    }
  }

  private isAbandoned(row: GiftCodeMapping): boolean {
    return this.now().getTime() - row.createdAt.getTime() >= this.staleReservationMs;
  }
}
