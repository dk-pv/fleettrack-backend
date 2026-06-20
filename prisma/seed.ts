import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash("admin123", 10);

  await prisma.user.upsert({
    where: {
      email: "admin@fleettrack.com",
    },
    update: {},
    create: {
      name: "Admin",
      email: "admin@fleettrack.com",
      password: hashedPassword,
      role: "ADMIN",
    },
  });

  console.log("Admin created");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());