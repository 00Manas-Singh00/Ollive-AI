import { getScheduledPromptQueue } from "@/lib/queue";

// Per-user cap on active schedules, and a floor on how one BullMQ job scheduler
// per ScheduledPrompt is keyed — both enforced here so routes stay thin.
export const MAX_SCHEDULES_PER_USER = Math.max(1, Number(process.env.MAX_SCHEDULES_PER_USER ?? 10) || 10);

function schedulerId(scheduleId: string): string {
  return `scheduled-prompt:${scheduleId}`;
}

/** Registers or updates the BullMQ repeatable job backing a ScheduledPrompt. */
export async function syncScheduleJob(schedule: { id: string; cronExpression: string; isActive: boolean }): Promise<void> {
  const queue = getScheduledPromptQueue();
  if (!schedule.isActive) {
    await queue.removeJobScheduler(schedulerId(schedule.id));
    return;
  }
  await queue.upsertJobScheduler(
    schedulerId(schedule.id),
    { pattern: schedule.cronExpression },
    { name: "run", data: { scheduleId: schedule.id } },
  );
}

/** Removes the BullMQ repeatable job for a deleted ScheduledPrompt. */
export async function removeScheduleJob(scheduleId: string): Promise<void> {
  const queue = getScheduledPromptQueue();
  await queue.removeJobScheduler(schedulerId(scheduleId));
}
