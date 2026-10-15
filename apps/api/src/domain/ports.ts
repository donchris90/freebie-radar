import type { Comparable } from '../core/scoring';
import type {
  AlertRec,
  AppealRec,
  AuditRec,
  BillingEventRec,
  BlockRec,
  ClaimRec,
  ClaimStatus,
  CodePurpose,
  CodeRec,
  Condition,
  ConversationRec,
  CountryRec,
  DeliveryRec,
  DeliveryStatus,
  ListingRec,
  MessageRec,
  MessageReportRec,
  ModerationRec,
  PaymentRec,
  ReferralCodeRec,
  RefreshRec,
  ReportRec,
  ReportReason,
  ReportStatus,
  ResaleRec,
  SourceRec,
  SubscriptionRec,
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
  /** How many listings this seller created from one source since a moment (used for the daily "spotted" cap). */
  countBySellerSourceSince(sellerId: string, sourceKey: string, since: Date): Promise<number>;
  /** Listings by these sellers that are or were genuinely live (not removed, not held for review). */
  countBySellerIds(sellerIds: string[]): Promise<number>;
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
  /** People who signed up with a referral code (newest first, capped). */
  idsReferredBy(code: string, limit: number): Promise<{ id: string; emailVerifiedAt: Date | null }[]>;
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

export interface ConversationRepo {
  /** Returns null when this buyer already has a conversation about the listing. */
  insert(c: ConversationRec): Promise<ConversationRec | null>;
  findById(id: string): Promise<ConversationRec | null>;
  findByListingBuyer(listingId: string, buyerId: string): Promise<ConversationRec | null>;
  listForUser(userId: string, limit: number): Promise<ConversationRec[]>;
  update(id: string, patch: Partial<Pick<ConversationRec, 'lastMessageAt' | 'lastMessageSenderId' | 'lastMessagePreview' | 'buyerLastReadAt' | 'sellerLastReadAt'>>): Promise<void>;
  countStartedBy(buyerId: string, since: Date): Promise<number>;
  addMessage(m: MessageRec): Promise<void>;
  findMessage(id: string): Promise<MessageRec | null>;
  /** Oldest first. `before` pages backwards through older messages. */
  messages(conversationId: string, before: Date | null, limit: number): Promise<MessageRec[]>;
  countMessagesBy(senderId: string, since: Date): Promise<number>;
  /** Messages `senderId` sent since the other person last wrote in this conversation. */
  countUnansweredBy(conversationId: string, senderId: string): Promise<number>;
  addReport(r: MessageReportRec): Promise<MessageReportRec | null>;
  findReport(id: string): Promise<MessageReportRec | null>;
  listReports(status: MessageReportRec['status'], offset: number, limit: number): Promise<{ items: MessageReportRec[]; total: number }>;
  setReportStatus(id: string, status: MessageReportRec['status']): Promise<void>;
}

/** What a person has done as a collector and as a giver. Feeds the reliability label. */
export interface ClaimTally {
  collected: number;
  noShow: number;
  /** The person cancelled after the giver had confirmed. */
  lateCancel: number;
  /** Items this person gave away (claims they confirmed as collected). */
  given: number;
}

export interface ClaimRepo {
  /** Null when the listing already has an active (held or confirmed) claim: only one person can reserve an item. */
  insertActive(c: ClaimRec): Promise<ClaimRec | null>;
  findById(id: string): Promise<ClaimRec | null>;
  activeForListing(listingId: string): Promise<ClaimRec | null>;
  /** Which of these listings currently have an active claim. */
  activeListingIds(listingIds: string[]): Promise<string[]>;
  countActiveByClaimer(claimerId: string): Promise<number>;
  /** Atomic: applies the patch only if the claim is still in one of `from`. Returns the updated claim for the one caller that won. */
  transition(id: string, from: ClaimStatus[], patch: Partial<Omit<ClaimRec, 'id'>>): Promise<ClaimRec | null>;
  listForClaimer(userId: string, limit: number): Promise<ClaimRec[]>;
  listForGiver(userId: string, limit: number): Promise<ClaimRec[]>;
  /** Active claims, oldest first, for the expiry job. */
  listActive(limit: number): Promise<ClaimRec[]>;
  tally(userId: string): Promise<ClaimTally>;
  countCollectedForGivers(giverIds: string[]): Promise<number>;
}

export interface ReferralRepo {
  /** Null when the code already exists. */
  insert(r: ReferralCodeRec): Promise<ReferralCodeRec | null>;
  find(code: string): Promise<ReferralCodeRec | null>;
  findByOwner(userId: string): Promise<ReferralCodeRec | null>;
  list(): Promise<ReferralCodeRec[]>;
  setActive(code: string, active: boolean): Promise<ReferralCodeRec | null>;
}

export interface BillingRepo {
  getSubscription(userId: string): Promise<SubscriptionRec | null>;
  findSubscriptionByRef(provider: string, providerRef: string): Promise<SubscriptionRec | null>;
  saveSubscription(s: SubscriptionRec): Promise<void>;
  listSubscriptions(statuses: SubscriptionRec['status'][]): Promise<SubscriptionRec[]>;
  /** Returns null when the reference or the provider's payment id is already recorded. */
  insertPayment(p: PaymentRec): Promise<PaymentRec | null>;
  findPayment(reference: string): Promise<PaymentRec | null>;
  findPaymentByProviderRef(providerPaymentRef: string): Promise<PaymentRec | null>;
  /** Atomic: applies the patch only if the payment is still in `from`. True for the one caller that won. */
  transitionPayment(id: string, from: PaymentRec['status'][], patch: Partial<Omit<PaymentRec, 'id'>>): Promise<boolean>;
  listPayments(f: { userId?: string; offset: number; limit: number }): Promise<{ items: PaymentRec[]; total: number }>;
  stalePending(before: Date): Promise<PaymentRec[]>;
  /** Records a delivery. `created` is false when this provider/eventKey was seen before. */
  beginEvent(provider: string, eventKey: string, type: string): Promise<{ event: BillingEventRec; created: boolean }>;
  /** A retried delivery of an event that did not finish. */
  retryEvent(id: string): Promise<void>;
  finishEvent(id: string, status: BillingEventRec['status'], error: string | null): Promise<void>;
  listEvents(f: { status?: BillingEventRec['status']; limit: number }): Promise<BillingEventRec[]>;
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
  conversations: ConversationRepo;
  claims: ClaimRepo;
  referrals: ReferralRepo;
  billing: BillingRepo;
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
