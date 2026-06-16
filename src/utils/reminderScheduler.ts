export interface ReminderCheckResult {
  shouldSend: boolean;
  reminderType: 'THREE_DAYS' | 'ONE_DAY' | null;
}

/**
 * Checks whether a reminder is due for a class scheduled on classDayOfWeek at classTime.
 */
export function checkReminderDue(
  now: Date,
  classDayOfWeek: number,
  classTime: string
): ReminderCheckResult {
  const [classHour, classMin] = classTime.split(':').map(Number);
  const nowHour = now.getHours();
  const nowMin = now.getMinutes();

  // Check if current time matches the class hour and minute
  if (nowHour !== classHour || nowMin !== classMin) {
    return { shouldSend: false, reminderType: null };
  }

  const nowDayOfWeek = now.getDay(); // 0 (Sun) to 6 (Sat)
  
  // Calculate days until class day (always positive, 0 to 6)
  const daysUntilClass = (classDayOfWeek - nowDayOfWeek + 7) % 7;

  if (daysUntilClass === 3) {
    return { shouldSend: true, reminderType: 'THREE_DAYS' };
  } else if (daysUntilClass === 1) {
    return { shouldSend: true, reminderType: 'ONE_DAY' };
  }

  return { shouldSend: false, reminderType: null };
}
