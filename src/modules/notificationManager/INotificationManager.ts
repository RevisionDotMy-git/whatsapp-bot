export interface INotificationManager {
  sendMessage(jid: string, text: string): Promise<void>;
  triggerClassReminders(workshopId: string): Promise<number>;
  runReminderCron(): Promise<void>;
}
