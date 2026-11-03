// Creates the first ADMIN of an empty database. If ANY admin already exists it does nothing, so a
// rerun never adds a duplicate or a second admin (even after the first admin changed their email);
// the unique User.email also stops two concurrent runs from both inserting. No default password:
// it comes only from SEED_ADMIN_PASSWORD, at least MIN_PASSWORD_LENGTH characters.
// Usage (bash, e.g. inside the api container; read -s keeps it off screen and out of history):
//   read -rsp 'Admin password: ' SEED_ADMIN_PASSWORD; echo; export SEED_ADMIN_PASSWORD; node prisma/seed.cjs; unset SEED_ADMIN_PASSWORD
// Usage (PowerShell): $env:SEED_ADMIN_PASSWORD = '...'; npx prisma db seed; Remove-Item Env:SEED_ADMIN_PASSWORD
// Plain .cjs on purpose: a .ts file here would be compiled by `nest build` and break the Dockerfile CMD.
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const EMAIL = 'admin@fleettrack.com';
const BCRYPT_ROUNDS = 10; // same as auth.service.ts and users.service.ts
// Stricter than the app's own 6/8-character minimums: this is the first admin of a production DB.
const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) throw new Error('SEED_ADMIN_PASSWORD is not set');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`SEED_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  // Query log (no parameters) shows exactly which statements the seed ran.
  const prisma = new PrismaClient({ log: ['query'] });
  try {
    const existing = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { email: true },
    });
    if (existing) {
      console.log(`An ADMIN already exists (${existing.email}); nothing created.`);
      return;
    }

    await prisma.user.create({
      data: {
        name: 'Super Admin',
        email: EMAIL,
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role: 'ADMIN',
      },
      select: { id: true },
    });
    console.log(`Created admin ${EMAIL}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
