import type { Comparable } from '../core/scoring';
import type {
  AlertRec,
  AppealRec,
  AuditRec,
  BlockRec,
  CodePurpose,
  CodeRec,
  Condition,
  CountryRec,
  DeliveryRec,
  DeliveryStatus,
  ListingRec,
  ModerationRec,
  RefreshRec,
  ReportRec,
  ReportReason,
  ReportStatus,
  ResaleRec,
  SourceRec,
  SyncRunRec,
  UserRec,
} from './models';

/**
 * Persistence ports. The in-memory adapter (infra/memory) backs tests and local development; a Prisma
 * adapter implements the same interface for production against prisma/schema.prisma.
 */

export interface ListingSearchFilter {
  q?: string;
  categoryKey?: string;
  freeOnly?: boolean;
  /** Minor units, applied only together with `currency`. */
  minPriceMinor?: number;
  maxPriceMinor?: number;
  currency?: string;
  condition?: Condition;
  countryCode?: string;
  center?: { lat: number; lng: number };
  radiusKm?: number;
  sort: 'newest' | 'nearest';
  sellerUserId?: string;
  /** Sellers the viewer has blocked; their listings are left out. */
  excludeSellerIds?: string[];
  /** Include only publicly listed statuses unless a caller (owner/admin) overrides. */
  publicOnly: boolean;
  offset: number;
  limit: number;
}

export interface ListingRepo {
  insert(l: ListingRec): Promise<ListingRec>;
  findById(id: string): Promise<ListingRec | null>;
  update(id: string, patch: Partial<ListingRec>): Promise<ListingRec | null>;
  search(f: ListingSearchFilter): Promise<{ items: ListingRec[]; total: number }>;
  findNear(lat: number, lng: number, radiusKm: number, excludeId?: string): Promise<ListingRec[]>;
  countBySellerSince(sellerId: string, since: Date): Promise<number>;
  countSameContentBySeller(sellerId: string, hash: string, since: Date): Promise<number>;
  comparablesFor(l: ListingRec): Promise<Comparable[]>;
  listForExpiry(): Promise<ListingRec[]>;
  findBySourceExternal(sourceKey: string, externalId: string): Promise<ListingRec | null>;
}

export interface SourceRepo {
  list(): Promise<SourceRec[]>;
  get(key: string): Promise<SourceRec | null>;
  /** Creates the source or refreshes its descriptive and freshness settings. Never changes `enabled`. */
  upsertConfig(rec: SourceRec): Promise<SourceRec>;
  setEnabled(key: string, enabled: boolean): Promise<SourceRec | null>;
}

export interface SyncRunRepo {
  start(r: SyncRunRec): Promise<void>;
  finish(id: string, patch: Partial<Pick<SyncRunRec, 'status' | 'fetched' | 'created' | 'updated' | 'rejected' | 'errorMessage'>>, at: Date): Promise<void>;
  recent(sourceKey: string | null, limit: number): Promise<SyncRunRec[]>;
  /** Start time of the newest run that finished OK, for incremental fetches. */
  lastOkStartedAt(sourceKey: string): Promise<Date | null>;
}

export interface UserRepo {
  insert(u: UserRec): Promise<UserRec>;
  findById(id: string): Promise<UserRec | null>;
  findByEmail(email: string): Promise<UserRec | null>;
  update(id: string, patch: Partial<UserRec>): Promise<UserRec | null>;
}

export interface TokenRepo {
  addRefresh(r: RefreshRec): Promise<void>;
  findRefresh(tokenHash: string): Promise<RefreshRec | null>;
  /** Atomic claim: true only for the caller that moved the token from active to revoked. */
  revokeRefresh(id: string, at: Date): Promise<boolean>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
  /** Stores a new code and retires earlier unused codes of the same purpose. */
  addCode(c: CodeRec): Promise<void>;
  latestCode(userId: string, purpose: CodePurpose): Promise<CodeRec | null>;
  /** Counts a wrong guess and returns the new attempt total. */
  bumpCodeAttempts(id: string): Promise<number>;
  /** Atomic: true only for the caller that consumed the code. */
  consumeCode(id: string, at: Date): Promise<boolean>;
  /** Deletes refresh tokens past their expiry and codes expired for over a day. Returns how many rows went. */
  purgeExpired(now: Date): Promise<number>;
}

export interface BlockRepo {
  add(blockerId: string, blockedId: string): Promise<void>;
  remove(blockerId: string, blockedId: string): Promise<boolean>;
  list(blockerId: string): Promise<BlockRec[]>;
  blockedIds(blockerId: string): Promise<string[]>;
}

export interface SavedRepo {
  save(userId: string, listingId: string): Promise<void>;
  unsave(userId: string, listingId: string): Promise<void>;
  listIds(userId: string): Promise<string[]>;
  dismiss(userId: string, listingId: string): Promise<void>;
  dismissedIds(userId: string): Promise<string[]>;
  bumpCategory(userId: string, categoryKey: string): Promise<void>;
  categoryWeights(userId: string): Promise<Record<string, number>>;
  resetPersonalisation(userId: string): Promise<void>;
}

export interface ReportRepo {
  /** Returns null when the same user already reported the listing for the same reason. */
  create(r: ReportRec): Promise<ReportRec | null>;
  findById(id: string): Promise<ReportRec | null>;
  distinctOpenReporters(listingId: string, reasons?: ReportReason[]): Promise<number>;
  listByStatus(status: ReportStatus, offset: number, limit: number): Promise<{ items: ReportRec[]; total: number }>;
  setStatus(id: string, status: ReportStatus): Promise<void>;
  setStatusForListing(listingId: string, status: ReportStatus): Promise<void>;
}

export interface AlertRepo {
  create(a: AlertRec): Promise<AlertRec>;
  listByUser(userId: string): Promise<AlertRec[]>;
  findById(id: string): Promise<AlertRec | null>;
  update(id: string, patch: Partial<AlertRec>): Promise<AlertRec | null>;
  delete(id: string): Promise<void>;
  listActive(): Promise<AlertRec[]>;
  /** Unique per (alertId, listingId). Returns null when a delivery already exists: the dedup guarantee. */
  recordDelivery(d: DeliveryRec): Promise<DeliveryRec | null>;
  setDeliveryStatus(id: string, status: DeliveryStatus, reason?: string): Promise<void>;
  countSentSince(userId: string, since: Date): Promise<number>;
  listDeliveries(userId: string, limit: number): Promise<DeliveryRec[]>;
  listPendingDeliveries(): Promise<DeliveryRec[]>;
}

export interface ResaleRepo {
  create(r: ResaleRec): Promise<ResaleRec>;
  listByUser(userId: string): Promise<ResaleRec[]>;
  findById(id: string): Promise<ResaleRec | null>;
  delete(id: string): Promise<void>;
}

export interface AuditRepo {
  add(a: AuditRec): Promise<void>;
  list(offset: number, limit: number): Promise<{ items: AuditRec[]; total: number }>;
}

export interface ModerationRepo {
  add(m: ModerationRec): Promise<ModerationRec>;
  findById(id: string): Promise<ModerationRec | null>;
  addAppeal(a: AppealRec): Promise<AppealRec>;
  listAppeals(status: AppealRec['status']): Promise<AppealRec[]>;
  findAppeal(id: string): Promise<AppealRec | null>;
  setAppealStatus(id: string, status: AppealRec['status']): Promise<void>;
  latestForListing(listingId: string): Promise<ModerationRec | null>;
}

export interface StatsRepo {
  stats(): Promise<{
    users: number;
    listingsByStatus: Record<string, number>;
    listingsBySource: Record<string, number>;
    listingsByCountry: Record<string, number>;
    duplicateListings: number;
    openReports: number;
    deliveriesByStatus: Record<string, number>;
  }>;
}

export interface CountryRepo {
  list(): Promise<CountryRec[]>;
  get(code: string): Promise<CountryRec | null>;
  /** Inserts the country only when it does not exist yet. Never overwrites an admin's enabled choice. */
  insertIfMissing(c: CountryRec): Promise<void>;
  setEnabled(code: string, enabled: boolean): Promise<CountryRec | null>;
}

export interface Repos {
  countries: CountryRepo;
  users: UserRepo;
  tokens: TokenRepo;
  blocks: BlockRepo;
  listings: ListingRepo;
  sources: SourceRepo;
  syncRuns: SyncRunRepo;
  saved: SavedRepo;
  reports: ReportRepo;
  alerts: AlertRepo;
  resale: ResaleRepo;
  audit: AuditRepo;
  moderation: ModerationRepo;
  stats: StatsRepo;
}

export const REPOS = Symbol('REPOS');
/** The PrismaClient, or null when running on the in-memory adapter. */
export const PRISMA = Symbol('PRISMA');

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}
export interface PushSender {
  isConfigured(): boolean;
  send(msg: PushMessage): Promise<{ sent: boolean; reason?: string }>;
}
export const PUSH_SENDER = Symbol('PUSH_SENDER');
