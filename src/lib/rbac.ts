import { UserRole } from "@prisma/client";

const ROLE_RANK: Record<UserRole, number> = {
  VIEWER: 0,
  ANALYST: 1,
  PROMPT_EDITOR: 2,
  ADMIN: 3,
};

export function requireRole(user: { role: UserRole }, minRole: UserRole): void {
  if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
    throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  }
}
