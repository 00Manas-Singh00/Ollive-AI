// Creates (or updates the password of) the admin user from ADMIN_EMAIL/ADMIN_PASSWORD.
// Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/seed-admin.mjs
import { PrismaClient } from "@prisma/client";
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";

if (!email || !password) {
  console.error("ADMIN_EMAIL and ADMIN_PASSWORD must both be set");
  process.exit(1);
}
if (password.length < 8) {
  console.error("ADMIN_PASSWORD must be at least 8 characters");
  process.exit(1);
}

const prisma = new PrismaClient();
const passwordHash = await hashPassword(password);

const user = await prisma.user.upsert({
  where: { email },
  create: { email, name: "Admin", passwordHash, role: "ADMIN" },
  update: { passwordHash, role: "ADMIN" },
});

console.log(`Admin user ready: ${user.email} (${user.id})`);
await prisma.$disconnect();
