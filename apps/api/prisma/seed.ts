import '../src/load-env';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

/**
 * Idempotent seed. Creates the two built-in listing sources and, only when ADMIN_EMAIL and
 * ADMIN_PASSWORD are set, one admin account. No listings or any other demo data are created.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' npm run seed
 */
async function main() {
  const prisma = new PrismaClient();
  try {
    await prisma.listingSource.upsert({
      where: { key: 'direct' },
      create: { key: 'direct', name: 'Posted on Freebie Radar', kind: 'DIRECT_SUBMISSION' },
      update: {},
    });
    await prisma.listingSource.upsert({
      where: { key: 'external-link' },
      create: { key: 'external-link', name: 'External link', kind: 'EXTERNAL_LINK' },
      update: {},
    });
    console.log('Listing sources ready: direct, external-link');

    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) {
      console.log('ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin account created.');
      return;
    }
    if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      await prisma.user.update({ where: { email }, data: { role: 'ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date() } });
      console.log(`Existing account ${email} promoted to ADMIN (password unchanged).`);
      return;
    }
    await prisma.user.create({
      data: {
        id: randomUUID(),
        email,
        passwordHash: await bcrypt.hash(password, 11),
        displayName: 'Administrator',
        role: 'ADMIN',
        emailVerifiedAt: new Date(),
        countryCode: (process.env.DEFAULT_COUNTRY ?? 'US').toUpperCase(),
        preference: { create: {} },
      },
    });
    console.log(`Admin account created: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
