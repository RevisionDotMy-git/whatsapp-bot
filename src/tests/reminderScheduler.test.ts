import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkReminderDue } from '../utils/reminderScheduler.js';

describe('Reminder Scheduler', () => {
  // Let's assume class is on Friday (5) at 14:00
  const classDayOfWeek = 5; // Friday
  const classTime = '14:00';

  it('should trigger THREE_DAYS reminder exactly 3 days before the class day', () => {
    // 3 days before Friday is Tuesday (2)
    // Class time Friday 14:00. Tuesday 14:00 should match.
    // Let's test Tuesday 2026-06-16 at 14:00:00 (which is Tuesday, local time or UTC)
    // 2026-06-16 is Tuesday.
    const now = new Date('2026-06-16T14:00:00'); // Tuesday
    const result = checkReminderDue(now, classDayOfWeek, classTime);

    expect(result).toEqual({
      shouldSend: true,
      reminderType: 'THREE_DAYS',
    });
  });

  it('should trigger ONE_DAY reminder exactly 1 day before the class day', () => {
    // 1 day before Friday is Thursday (4)
    // Thursday 2026-06-18 at 14:00:00
    const now = new Date('2026-06-18T14:00:00'); // Thursday
    const result = checkReminderDue(now, classDayOfWeek, classTime);

    expect(result).toEqual({
      shouldSend: true,
      reminderType: 'ONE_DAY',
    });
  });

  it('should not trigger reminder if time does not match class time hour', () => {
    const now = new Date('2026-06-16T10:00:00'); // Tuesday, but 10am instead of 2pm
    const result = checkReminderDue(now, classDayOfWeek, classTime);

    expect(result.shouldSend).toBe(false);
  });

  it('should not trigger reminder on non-reminder days', () => {
    const now = new Date('2026-06-17T14:00:00'); // Wednesday (2 days before)
    const result = checkReminderDue(now, classDayOfWeek, classTime);

    expect(result.shouldSend).toBe(false);
  });
});
