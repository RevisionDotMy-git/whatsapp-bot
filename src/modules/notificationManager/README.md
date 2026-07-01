# Notification Manager Module

This module abstracts outgoing WhatsApp communication, runs scheduled hourly homework reminders, and handles manually triggered class reminders.

## Interface
`INotificationManager`

## Methods
- `sendMessage(jid, text)`: Invokes the constructor's abstract callback to send messages (routing to OpenClaw REST APIs or direct Baileys clients).
- `triggerClassReminders(workshopId)`: Queries WordPress student course progresses, syncs them to local progress logs, and sends a WhatsApp message warning to students with outstanding homework.
- `runReminderCron()`: Automatically checks class schedules to identify if homework reminders are due. If yes, scans course progress records, caches them, and sends a notification.
