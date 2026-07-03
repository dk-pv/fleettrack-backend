/*
 * One-off admin password recovery script.  DELETE THIS FILE after use.
 *
 * It resets the password of an existing User and guarantees role = ADMIN,
 * using the project's own Prisma client + bcrypt (salt rounds 10, matching
 * users.service.ts and auth.service.ts). Nothing is exposed over the network.
 *
 * Usage (run from the fleettrack-api folder):
 *
 *   1) List existing admins so you can pick the right email:
 *        node scripts/reset-admin.js
 *
 *   2) Reset the password for that account (PowerShell):
 *        $env:ADMIN_EMAIL="admin@example.com"; $env:ADMIN_PASSWORD="YourNewPass123"; node scripts/reset-admin.js
 *
 * The email/password are read from env vars so no secret is written into this file.
 */

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

const SALT_ROUNDS = 10; // must match users.service.ts

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  // No credentials provided -> read-only listing of existing admins.
  if (!email || !password) {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: { id: true, name: true, email: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    console.log('\nExisting ADMIN users:');
    if (admins.length === 0) {
      console.log('  (none found — no User row has role=ADMIN)');
      console.log('  You will need the "create new admin" path instead.');
    } else {
      admins.forEach((a) =>
        console.log(`  - ${a.email}   name="${a.name}"   id=${a.id}`),
      );
    }

    console.log(
      '\nTo reset one, re-run with ADMIN_EMAIL and ADMIN_PASSWORD set (see header).',
    );
    return;
  }

  // Matches CreateUserDto: password min length 6.
  if (password.length < 6) {
    throw new Error('ADMIN_PASSWORD must be at least 6 characters.');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    throw new Error(
      `No User found with email "${email}". ` +
        'Run without env vars to list admins, or use the create-admin path.',
    );
  }

  const hashed = await bcrypt.hash(password, SALT_ROUNDS);

  const updated = await prisma.user.update({
    where: { email },
    data: { password: hashed, role: 'ADMIN' },
    select: { id: true, name: true, email: true, role: true },
  });

  console.log(
    `\n✅ Password reset for "${updated.email}" (role: ${updated.role}).` +
      '\n   You can now log in with the new password.' +
      '\n   Delete scripts/reset-admin.js now that recovery is done.',
  );
}

main()
  .catch((err) => {
    console.error('\n❌ Recovery failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
