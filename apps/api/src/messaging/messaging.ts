import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from '../auth/auth';
import { APP_CONFIG, AppConfig } from '../config/config';
import { guardMessage, previewOf } from '../core/messaging';
import { ConversationRec, MESSAGE_REPORT_REASONS, MessageRec, MessageReportReason, UserRec } from '../domain/models';
import { PUSH_SENDER, PushSender, REPOS, Repos } from '../domain/ports';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Per-IP/user request ceiling for sending, on top of the account-level limits below. */
const SEND_LIMIT = Number(process.env.MSG_THROTTLE_LIMIT ?? 30);

export class StartConversationDto {
  @IsString() @Length(1, 2000) message!: string;
}
export class SendMessageDto {
  @IsString() @Length(1, 2000) message!: string;
}
export class ReportMessageDto {
  @IsIn(MESSAGE_REPORT_REASONS) reason!: MessageReportReason;
  @IsOptional() @IsString() @MaxLength(1000) details?: string;
}
export class MessagePageDto {
  /** ISO timestamp: return messages older than this. */
  @IsOptional() @IsString() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
export class ResolveMessageReportDto {
  @IsIn(['DISMISS', 'ACTION']) action!: 'DISMISS' | 'ACTION';
  @IsString() @Length(3, 500) note!: string;
}
export class MessageReportsPageDto {
  @IsOptional() @IsIn(['OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED']) status?: 'OPEN' | 'IN_REVIEW' | 'ACTIONED' | 'DISMISSED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

type ClosedReason = 'LISTING_UNAVAILABLE' | 'LISTING_NOT_CONFIRMED' | 'BLOCKED' | 'ACCOUNT_UNAVAILABLE' | null;

const CLOSED_TEXT: Record<Exclude<ClosedReason, null>, string> = {
  LISTING_UNAVAILABLE: 'This listing is no longer available, so the conversation is closed.',
  LISTING_NOT_CONFIRMED: 'This listing has not been confirmed recently and may be gone. You can read the conversation but not add to it until the seller confirms.',
  BLOCKED: 'This conversation is closed.',
  ACCOUNT_UNAVAILABLE: 'This conversation is closed.',
};

@Injectable()
export class MessagingService {
  constructor(
    @Inject(REPOS) private readonly repos: Repos,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  private requireVerified(user: UserRec) {
    if (this.cfg.requireVerifiedEmail && !user.emailVerifiedAt && user.role === 'USER') {
      throw new ForbiddenException('Verify your email before sending messages. Open Profile and enter the code we sent you.');
    }
  }

  private tooMany(message: string): never {
    throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Validates and screens a message body; throws a clear 400 when it cannot be sent. */
  private screen(body: string) {
    const text = body.trim();
    if (!text) throw new BadRequestException('Write a message first.');
    if (text.length > this.cfg.messaging.maxBodyChars) throw new BadRequestException(`Messages can be up to ${this.cfg.messaging.maxBodyChars} characters.`);
    const g = guardMessage(text);
    if (!g.ok) throw new BadRequestException(g.reason);
    return { text, flagged: g.flagged };
  }

  private async closedReason(conv: ConversationRec, viewerId: string): Promise<ClosedReason> {
    const listing = await this.repos.listings.findById(conv.listingId);
    if (!listing || (listing.status !== 'ACTIVE' && listing.status !== 'POSSIBLY_EXPIRED')) return 'LISTING_UNAVAILABLE';
    const otherId = viewerId === conv.buyerId ? conv.sellerId : conv.buyerId;
    const [mine, theirs] = await Promise.all([this.repos.blocks.blockedIds(viewerId), this.repos.blocks.blockedIds(otherId)]);
    if (mine.includes(otherId) || theirs.includes(viewerId)) return 'BLOCKED';
    const other = await this.repos.users.findById(otherId);
    if (!other || other.status !== 'ACTIVE') return 'ACCOUNT_UNAVAILABLE';
    if (listing.status === 'POSSIBLY_EXPIRED') return 'LISTING_NOT_CONFIRMED';
    return null;
  }

  /** Finds or opens the conversation for this listing and sends the first message into it. */
  async start(user: UserRec, listingId: string, dto: StartConversationDto) {
    this.requireVerified(user);
    const listing = await this.repos.listings.findById(listingId);
    const hidden = new NotFoundException('Listing not found');
    if (!listing || !listing.sellerUserId) {
      if (listing && !listing.sellerUserId) throw new BadRequestException('This listing comes from an outside source. Use "Open original listing" to contact them.');
      throw hidden;
    }
    // The member who spotted a curb find does not own it, so there is nobody to ask about it.
    if (listing.sourceKey === 'spotted') throw new BadRequestException('This item was spotted outside by a member, so there is nobody to message about it. Tap "Gone" if it has been taken.');
    if (listing.status === 'POSSIBLY_EXPIRED') throw new BadRequestException(CLOSED_TEXT.LISTING_NOT_CONFIRMED);
    if (listing.status !== 'ACTIVE') throw hidden;
    if (listing.sellerUserId === user.id) throw new BadRequestException('This is your own listing.');
    const seller = await this.repos.users.findById(listing.sellerUserId);
    if (!seller || seller.status !== 'ACTIVE') throw hidden;
    // A block in either direction looks like the listing does not exist; the blocked person is not told.
    if ((await this.repos.blocks.blockedIds(user.id)).includes(seller.id) || (await this.repos.blocks.blockedIds(seller.id)).includes(user.id)) throw hidden;

    const { text, flagged } = this.screen(dto.message);
    let conv = await this.repos.conversations.findByListingBuyer(listingId, user.id);
    if (!conv) {
      if ((await this.repos.conversations.countStartedBy(user.id, new Date(Date.now() - DAY))) >= this.cfg.messaging.newConversationsPerDay) {
        this.tooMany('You have started a lot of conversations today. Wait for replies, or try again tomorrow.');
      }
      const now = new Date();
      const fresh: ConversationRec = { id: randomUUID(), listingId, buyerId: user.id, sellerId: seller.id, createdAt: now, lastMessageAt: now, lastMessageSenderId: null, lastMessagePreview: '', buyerLastReadAt: now, sellerLastReadAt: null };
      conv = (await this.repos.conversations.insert(fresh)) ?? (await this.repos.conversations.findByListingBuyer(listingId, user.id))!;
    }
    const message = await this.deliver(user, conv, text, flagged, listing.title);
    return { conversationId: conv.id, message };
  }

  async send(user: UserRec, id: string, dto: SendMessageDto) {
    this.requireVerified(user);
    const conv = await this.participantOrThrow(user, id);
    const closed = await this.closedReason(conv, user.id);
    if (closed && closed !== 'LISTING_NOT_CONFIRMED') throw new ForbiddenException(CLOSED_TEXT[closed]);
    // The seller can always answer a conversation on an unconfirmed listing: that is how it gets confirmed.
    if (closed === 'LISTING_NOT_CONFIRMED' && user.id !== conv.sellerId) throw new ForbiddenException(CLOSED_TEXT[closed]);
    const { text, flagged } = this.screen(dto.message);
    const listing = await this.repos.listings.findById(conv.listingId);
    return this.deliver(user, conv, text, flagged, listing?.title ?? 'a listing');
  }

  private async deliver(user: UserRec, conv: ConversationRec, text: string, flagged: boolean, listingTitle: string) {
    const lim = this.cfg.messaging;
    if ((await this.repos.conversations.countMessagesBy(user.id, new Date(Date.now() - HOUR))) >= lim.messagesPerHour) {
      this.tooMany('You are sending messages very quickly. Take a short break and try again.');
    }
    if ((await this.repos.conversations.countUnansweredBy(conv.id, user.id)) >= lim.maxUnanswered) {
      this.tooMany('You have sent several messages without a reply. Please wait for a response.');
    }
    const msg: MessageRec = { id: randomUUID(), conversationId: conv.id, senderId: user.id, body: text, flagged, createdAt: new Date() };
    await this.repos.conversations.addMessage(msg);
    const isBuyer = user.id === conv.buyerId;
    await this.repos.conversations.update(conv.id, {
      lastMessageAt: msg.createdAt, lastMessageSenderId: user.id, lastMessagePreview: previewOf(text),
      ...(isBuyer ? { buyerLastReadAt: msg.createdAt } : { sellerLastReadAt: msg.createdAt }),
    });
    await this.notify(conv, user, listingTitle);
    return this.messageView(msg, user.id);
  }

  /** Push says only that something arrived; the text stays inside the app. Best effort. */
  private async notify(conv: ConversationRec, sender: UserRec, listingTitle: string) {
    try {
      const to = await this.repos.users.findById(sender.id === conv.buyerId ? conv.sellerId : conv.buyerId);
      if (!to || to.status !== 'ACTIVE' || !to.prefs.pushEnabled || !to.prefs.pushToken) return;
      await this.push.send({ token: to.prefs.pushToken, title: 'New message', body: `About: ${listingTitle}`.slice(0, 100), data: { conversationId: conv.id } });
    } catch { /* a failed push must never fail a message */ }
  }

  private messageView(m: MessageRec, viewerId: string) {
    const mine = m.senderId === viewerId;
    const g = guardMessage(m.body);
    // Only the recipient sees the caution; the sender is not told their message was flagged.
    return { id: m.id, mine, body: m.body, at: m.createdAt.toISOString(), caution: !mine && m.flagged && g.ok ? g.flagReason : undefined };
  }

  private async participantOrThrow(user: UserRec, id: string): Promise<ConversationRec> {
    const conv = await this.repos.conversations.findById(id);
    if (!conv || (conv.buyerId !== user.id && conv.sellerId !== user.id)) throw new NotFoundException('Conversation not found');
    return conv;
  }

  private async summary(conv: ConversationRec, viewer: UserRec) {
    const iAmBuyer = conv.buyerId === viewer.id;
    const [listing, other, closed] = await Promise.all([
      this.repos.listings.findById(conv.listingId),
      this.repos.users.findById(iAmBuyer ? conv.sellerId : conv.buyerId),
      this.closedReason(conv, viewer.id),
    ]);
    const readAt = iAmBuyer ? conv.buyerLastReadAt : conv.sellerLastReadAt;
    return {
      id: conv.id,
      role: iAmBuyer ? ('BUYER' as const) : ('SELLER' as const),
      listing: listing ? { id: listing.id, title: listing.title, status: listing.status, image: listing.imageUrls[0] ?? null } : { id: conv.listingId, title: 'Removed listing', status: 'REMOVED', image: null },
      other: { displayName: other && other.status !== 'DELETED' ? other.displayName : 'Former member' },
      lastMessage: conv.lastMessageSenderId ? { preview: conv.lastMessagePreview, at: conv.lastMessageAt.toISOString(), mine: conv.lastMessageSenderId === viewer.id } : null,
      unread: !!conv.lastMessageSenderId && conv.lastMessageSenderId !== viewer.id && (!readAt || readAt < conv.lastMessageAt),
      canReply: closed === null || (closed === 'LISTING_NOT_CONFIRMED' && !iAmBuyer),
      closedReason: closed,
      closedMessage: closed ? CLOSED_TEXT[closed] : null,
    };
  }

  async list(user: UserRec) {
    const mine = await this.repos.blocks.blockedIds(user.id);
    const convs = await this.repos.conversations.listForUser(user.id, 100);
    // Conversations with someone you blocked drop out of your inbox.
    const visible = convs.filter((c) => !mine.includes(c.buyerId === user.id ? c.sellerId : c.buyerId));
    const items = await Promise.all(visible.map((c) => this.summary(c, user)));
    return { items, unread: items.filter((i) => i.unread).length };
  }

  async get(user: UserRec, id: string, q: MessagePageDto) {
    const conv = await this.participantOrThrow(user, id);
    if ((await this.repos.blocks.blockedIds(user.id)).includes(conv.buyerId === user.id ? conv.sellerId : conv.buyerId)) throw new NotFoundException('Conversation not found');
    let before: Date | null = null;
    if (q.before) {
      before = new Date(q.before);
      if (Number.isNaN(before.getTime())) throw new BadRequestException('Invalid "before"');
    }
    const limit = q.limit ?? 50;
    const rows = await this.repos.conversations.messages(id, before, limit);
    const now = new Date();
    if (!before) await this.repos.conversations.update(id, conv.buyerId === user.id ? { buyerLastReadAt: now } : { sellerLastReadAt: now });
    return {
      conversation: await this.summary({ ...conv, ...(before ? {} : conv.buyerId === user.id ? { buyerLastReadAt: now } : { sellerLastReadAt: now }) }, user),
      messages: rows.map((m) => this.messageView(m, user.id)),
      hasMore: rows.length === limit,
    };
  }

  /** Blocks the other person: they vanish from your inbox and listings, and cannot message you. They are not told. */
  async block(user: UserRec, id: string) {
    const conv = await this.participantOrThrow(user, id);
    const otherId = conv.buyerId === user.id ? conv.sellerId : conv.buyerId;
    await this.repos.blocks.add(user.id, otherId);
    await this.repos.audit.add({ id: randomUUID(), actorId: user.id, action: 'USER_BLOCKED_FROM_CHAT', entityType: 'Conversation', entityId: id, metadata: {}, createdAt: new Date() });
    return { blocked: true };
  }

  async report(user: UserRec, messageId: string, dto: ReportMessageDto) {
    const m = await this.repos.conversations.findMessage(messageId);
    if (!m) throw new NotFoundException('Message not found');
    const conv = await this.repos.conversations.findById(m.conversationId);
    if (!conv || (conv.buyerId !== user.id && conv.sellerId !== user.id)) throw new NotFoundException('Message not found');
    if (m.senderId === user.id) throw new BadRequestException('You cannot report your own message.');
    const r = await this.repos.conversations.addReport({ id: randomUUID(), messageId, reporterId: user.id, reason: dto.reason, details: dto.details?.trim() || null, status: 'OPEN', createdAt: new Date() });
    // Reporting also stops further contact from that person.
    await this.repos.blocks.add(user.id, m.senderId);
    return { reported: true, duplicate: r === null };
  }

  // ---- moderation: only reported messages (with a little surrounding context) are ever shown to staff ----
  async reportQueue(q: MessageReportsPageDto) {
    const { items, total } = await this.repos.conversations.listReports(q.status ?? 'OPEN', q.offset ?? 0, q.limit ?? 25);
    const rows = await Promise.all(items.map(async (r) => {
      const m = await this.repos.conversations.findMessage(r.messageId);
      const conv = m && (await this.repos.conversations.findById(m.conversationId));
      const [reporter, sender, listing] = await Promise.all([
        this.repos.users.findById(r.reporterId),
        m ? this.repos.users.findById(m.senderId) : null,
        conv ? this.repos.listings.findById(conv.listingId) : null,
      ]);
      const context = m && conv ? await this.repos.conversations.messages(conv.id, new Date(m.createdAt.getTime() + 1), 8) : [];
      return {
        report: { id: r.id, reason: r.reason, details: r.details, status: r.status, createdAt: r.createdAt.toISOString() },
        reporter: reporter && { id: reporter.id, displayName: reporter.displayName },
        sender: sender && { id: sender.id, displayName: sender.displayName, status: sender.status },
        listing: listing && { id: listing.id, title: listing.title },
        message: m && { id: m.id, body: m.body, flagged: m.flagged, at: m.createdAt.toISOString() },
        context: context.map((c) => ({ id: c.id, fromReportedUser: c.senderId === m?.senderId, body: c.body, at: c.createdAt.toISOString() })),
      };
    }));
    return { items: rows, total };
  }

  async resolveReport(admin: UserRec, id: string, dto: ResolveMessageReportDto) {
    const r = await this.repos.conversations.findReport(id);
    if (!r) throw new NotFoundException('Report not found');
    if (r.status === 'ACTIONED' || r.status === 'DISMISSED') throw new BadRequestException('This report is already resolved.');
    const status = dto.action === 'ACTION' ? 'ACTIONED' : 'DISMISSED';
    await this.repos.conversations.setReportStatus(id, status);
    await this.repos.audit.add({ id: randomUUID(), actorId: admin.id, action: `MESSAGE_REPORT_${status}`, entityType: 'MessageReport', entityId: id, metadata: { note: dto.note }, createdAt: new Date() });
    return { id, status };
  }
}

@Controller()
@UseGuards(JwtAuthGuard)
export class MessagingController {
  constructor(private readonly svc: MessagingService) {}

  @Get('conversations')
  list(@CurrentUser() u: UserRec) { return this.svc.list(u); }

  @Throttle({ default: { limit: SEND_LIMIT, ttl: 60_000 } })
  @Post('listings/:id/conversations')
  start(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: StartConversationDto) { return this.svc.start(u, id, dto); }

  @Get('conversations/:id')
  get(@CurrentUser() u: UserRec, @Param('id') id: string, @Query() q: MessagePageDto) { return this.svc.get(u, id, q); }

  @Throttle({ default: { limit: SEND_LIMIT, ttl: 60_000 } })
  @Post('conversations/:id/messages')
  send(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: SendMessageDto) { return this.svc.send(u, id, dto); }

  @Post('conversations/:id/block')
  block(@CurrentUser() u: UserRec, @Param('id') id: string) { return this.svc.block(u, id); }

  @Post('messages/:id/report')
  report(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: ReportMessageDto) { return this.svc.report(u, id, dto); }
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class MessageModerationController {
  constructor(private readonly svc: MessagingService) {}

  @Roles('MODERATOR', 'ADMIN') @Get('admin/message-reports')
  queue(@Query() q: MessageReportsPageDto) { return this.svc.reportQueue(q); }
  @Roles('MODERATOR', 'ADMIN') @Post('admin/message-reports/:id/resolve')
  resolve(@CurrentUser() u: UserRec, @Param('id') id: string, @Body() dto: ResolveMessageReportDto) { return this.svc.resolveReport(u, id, dto); }
}
