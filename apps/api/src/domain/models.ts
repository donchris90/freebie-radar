import type { RiskSignal } from '../core/risk';

export type Role = 'USER' | 'BUSINESS' | 'MODERATOR' | 'ADMIN';
export type Tier = 'FREE' | 'PREMIUM' | 'BUSINESS';
export type Condition = 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR' | 'POOR' | 'FOR_PARTS' | 'UNKNOWN';
export const CONDITIONS: Condition[] = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR', 'FOR_PARTS', 'UNKNOWN'];
export type ListingStatus =
  | 'ACTIVE'
  | 'POSSIBLY_EXPIRED'
  | 'REPORTED_UNAVAILABLE'
  | 'CONFIRMED_UNAVAILABLE'
  | 'REMOVED'
  | 'UNDER_REVIEW';
export type RiskLevel = 'NO_MAJOR_SIGNALS' | 'EXERCISE_CAUTION' | 'UNDER_REVIEW';
export type ContactMethod = 'IN_APP' | 'EMAIL_RELAY' | 'EXTERNAL_LINK';
export type AlertFrequency = 'IMMEDIATE' | 'HOURLY_DIGEST' | 'DAILY_DIGEST';

export interface UserPrefs {
  distanceUnit: 'mi' | 'km';
  homeLat: number | null;
  homeLng: number | null;
  homeLabel: string | null;
  locationPrecision: 'approximate' | 'precise' | 'manual';
  personalisationEnabled: boolean;
  pushEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  maxPushPerDay: number;
  pushToken: string | null;
}

export interface UserRec {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: Role;
  tier: Tier;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  countryCode: string;
  timeZone: string;
  locale: string;
  prefs: UserPrefs;
  emailVerifiedAt: Date | null;
  /** Bumped to invalidate every access token issued earlier. */
  tokenVersion: number;
  createdAt: Date;
}

export interface RefreshRec {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export type CodePurpose = 'EMAIL_VERIFY' | 'PASSWORD_RESET';
export interface CodeRec {
  id: string;
  userId: string;
  purpose: CodePurpose;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface BlockRec {
  blockerId: string;
  blockedId: string;
  createdAt: Date;
}

export interface ListingRec {
  id: string;
  sourceKey: string;
  externalId: string | null;
  sellerUserId: string | null;
  title: string;
  description: string;
  categoryKey: string;
  condition: Condition;
  priceMinor: number | null;
  currency: string;
  isFree: boolean;
  countryCode: string;
  lat: number; // exact, private
  lng: number;
  locationLabel: string | null;
  contactMethod: ContactMethod;
  externalUrl: string | null;
  canonicalUrl: string | null;
  status: ListingStatus;
  riskLevel: RiskLevel;
  riskSignals: RiskSignal[];
  contentHash: string;
  duplicateOfId: string | null;
  isPromoted: boolean;
  imageUrls: string[];
  postedAt: Date;
  lastConfirmedAt: Date;
  expiresAt: Date | null;
}

export type ReportReason = 'EXPIRED' | 'UNAVAILABLE' | 'SUSPICIOUS' | 'SCAM' | 'DUPLICATE' | 'PROHIBITED_ITEM' | 'WRONG_INFO' | 'OTHER';
export const REPORT_REASONS: ReportReason[] = ['EXPIRED', 'UNAVAILABLE', 'SUSPICIOUS', 'SCAM', 'DUPLICATE', 'PROHIBITED_ITEM', 'WRONG_INFO', 'OTHER'];
export type ReportStatus = 'OPEN' | 'IN_REVIEW' | 'ACTIONED' | 'DISMISSED';

export interface ReportRec {
  id: string;
  listingId: string;
  reporterId: string;
  reason: ReportReason;
  details: string | null;
  evidenceUrl: string | null;
  status: ReportStatus;
  createdAt: Date;
}

export interface AlertRec {
  id: string;
  userId: string;
  name: string;
  keywords: string[];
  excludedWords: string[];
  categories: string[];
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  currency: string | null;
  freeOnly: boolean;
  radiusKm: number | null;
  centerLat: number | null;
  centerLng: number | null;
  conditions: Condition[];
  minDealScore: number | null;
  sourceKeys: string[];
  frequency: AlertFrequency;
  active: boolean;
  lastDigestAt: Date | null;
  createdAt: Date;
}

export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED_LIMIT' | 'SKIPPED_PREFERENCES';
export interface DeliveryRec {
  id: string;
  alertId: string;
  listingId: string;
  status: DeliveryStatus;
  reason: string | null;
  createdAt: Date;
}

export interface ResaleRec {
  id: string;
  userId: string;
  listingId: string | null;
  label: string;
  currency: string;
  input: {
    purchaseMinor: number;
    resaleMinor: number;
    transportMinor: number;
    repairMinor: number;
    otherMinor: number;
    feeBasisPoints: number;
    feeFixedMinor: number;
  };
  createdAt: Date;
}

export interface AuditRec {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export type ModerationType = 'REMOVE_LISTING' | 'MARK_UNDER_REVIEW' | 'RESTORE_LISTING' | 'DISMISS_REPORT';
export interface ModerationRec {
  id: string;
  listingId: string;
  moderatorId: string;
  type: ModerationType;
  reason: string;
  createdAt: Date;
}

export interface AppealRec {
  id: string;
  moderationId: string;
  userId: string;
  message: string;
  status: 'PENDING' | 'UPHELD' | 'REJECTED';
  createdAt: Date;
}

export interface CountryRec {
  code: string;
  name: string;
  currency: string;
  distanceUnit: 'mi' | 'km';
  defaultTimeZone: string;
  enabled: boolean;
}

export interface SourceRec {
  key: string;
  name: string;
  kind: 'DIRECT_SUBMISSION' | 'EXTERNAL_LINK' | 'API_PROVIDER';
  enabled: boolean;
  /** Empty = every enabled country the provider supports. */
  countries: string[];
  expireAfterHours: number;
  retireAfterHours: number;
  recheckIntervalHours: number | null;
  rateLimitPerMinute: number | null;
  attribution: string | null;
  attributionUrl: string | null;
  permissionNote: string | null;
}

export type SyncStatus = 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED' | 'RATE_LIMITED' | 'NOT_CONFIGURED' | 'SKIPPED';

export interface SyncRunRec {
  id: string;
  sourceKey: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: SyncStatus;
  fetched: number;
  created: number;
  updated: number;
  rejected: number;
  errorMessage: string | null;
}

export interface ConversationRec {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  createdAt: Date;
  lastMessageAt: Date;
  lastMessageSenderId: string | null;
  lastMessagePreview: string;
  buyerLastReadAt: Date | null;
  sellerLastReadAt: Date | null;
}

export interface MessageRec {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  flagged: boolean;
  createdAt: Date;
}

export type MessageReportReason = 'SPAM' | 'SCAM' | 'HARASSMENT' | 'CONTACT_DETAILS' | 'OTHER';
export const MESSAGE_REPORT_REASONS: MessageReportReason[] = ['SPAM', 'SCAM', 'HARASSMENT', 'CONTACT_DETAILS', 'OTHER'];

export interface MessageReportRec {
  id: string;
  messageId: string;
  reporterId: string;
  reason: MessageReportReason;
  details: string | null;
  status: ReportStatus;
  createdAt: Date;
}
