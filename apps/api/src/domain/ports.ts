import type { Comparable } from '../core/scoring';
import type {
  AlertRec,
  AppealRec,
  AuditRec,
  Condition,
  DeliveryRec,
  DeliveryStatus,
  ListingRec,
  ModerationRec,
  ReportRec,
  ReportReason,
  ReportStatus,
  ResaleRec,
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
}

export interface UserRepo {
  insert(u: UserRec): Promise<UserRec>;
  findById(id: string): Promise<UserRec | null>;
  findByEmail(email: string): Promise<UserRec | null>;
  update(id: string, patch: Partial<UserRec>): Promise<UserRec | null>;
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

export interface Repos {
  users: UserRepo;
  listings: ListingRepo;
  saved: SavedRepo;
  reports: ReportRepo;
  alerts: AlertRepo;
  resale: ResaleRepo;
  audit: AuditRepo;
  moderation: ModerationRepo;
  stats: StatsRepo;
}

export const REPOS = Symbol('REPOS');

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
