import { PrismaClient } from '@prisma/client';
import { logAudit } from '../../services/db.js';
import { ILearnDashSync } from '../learndashSync/ILearnDashSync.js';
import { evaluateProgress } from '../../utils/progressEvaluator.js';
import { checkReminderDue } from '../../utils/reminderScheduler.js';
import { INotificationManager } from './INotificationManager.js';

export class NotificationManager implements INotificationManager {
  private prisma: PrismaClient;
  private learndash: ILearnDashSync;
  private sendMsgFn: (jid: string, text: string) => Promise<void>;

  constructor(
    prisma: PrismaClient,
    learndash: ILearnDashSync,
    sendMsgFn: (jid: string, text: string) => Promise<void>
  ) {
    this.prisma = prisma;
    this.learndash = learndash;
    this.sendMsgFn = sendMsgFn;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.sendMsgFn(jid, text);
  }

  async triggerClassReminders(workshopId: string): Promise<number> {
    const now = new Date();
    const workshop = await this.prisma.workshop.findUnique({
      where: { id: workshopId },
      include: {
        homeworks: {
          where: { dueDate: { gte: now } },
        },
        students: {
          include: { student: true },
        },
      },
    });

    if (!workshop) {
      throw new Error('Workshop not found.');
    }

    let count = 0;
    for (const homework of workshop.homeworks) {
      for (const enrollment of workshop.students) {
        const student = enrollment.student;
        try {
          const progressData = await this.learndash.getStudentCourseProgress(student.learndashId, workshop.courseId);
          const status = evaluateProgress(progressData, homework.lessonId);
          
          await this.prisma.progressLog.upsert({
            where: {
              studentId_homeworkId: {
                studentId: student.id,
                homeworkId: homework.id,
              },
            },
            create: {
              studentId: student.id,
              homeworkId: homework.id,
              status,
            },
            update: {
              status,
            },
          });

          if (status !== 'COMPLETED') {
            const reminderMsg =
              `🔔 *HOMEWORK REMINDER* 🔔\n\n` +
              `Hi *${student.name}*,\n` +
              `This is an assistant reminder for *${workshop.subject}*.\n\n` +
              `You have not completed the homework: *${homework.title}*.\n` +
              `Your current status is: *${status.replace('_', ' ')}*.\n\n` +
              `Please complete it on LearnDash before our next class!\n` +
              `🔗 *Class Meeting Link*: ${workshop.meetingLink || 'TBA'}`;

            await this.sendMessage(student.phoneNumber, reminderMsg);
            count++;
          }
        } catch (err: any) {
          await logAudit(
            'ERROR',
            'TRIGGER_REMINDER_STUDENT_FAIL',
            `Failed triggering reminder for student ${student.name}: ${err.message}`
          );
        }
      }
    }
    return count;
  }

  async runReminderCron(): Promise<void> {
    const now = new Date();
    await logAudit('INFO', 'RUN_REMINDER_CRON', 'Starting progress validation and reminder cycle.');

    const workshops = await this.prisma.workshop.findMany({
      include: {
        teacher: true,
        homeworks: {
          where: { dueDate: { gte: now } },
        },
        students: {
          include: { student: true },
        },
      },
    });

    for (const workshop of workshops) {
      const reminderCheck = checkReminderDue(now, workshop.classDayOfWeek, workshop.classTime);

      for (const homework of workshop.homeworks) {
        for (const enrollment of workshop.students) {
          const student = enrollment.student;
          
          try {
            const progressData = await this.learndash.getStudentCourseProgress(student.learndashId, workshop.courseId);
            const status = evaluateProgress(progressData, homework.lessonId);

            await this.prisma.progressLog.upsert({
              where: {
                studentId_homeworkId: {
                  studentId: student.id,
                  homeworkId: homework.id,
                },
              },
              create: {
                studentId: student.id,
                homeworkId: homework.id,
                status,
              },
              update: {
                status,
              },
            });

            if (reminderCheck.shouldSend && status !== 'COMPLETED') {
              const reminderMsg =
                `🔔 *HOMEWORK REMINDER* 🔔\n\n` +
                `Hi *${student.name}*,\n` +
                `This is an assistant reminder for *${workshop.subject}*.\n\n` +
                `You have not completed the homework: *${homework.title}*.\n` +
                `Your current status is: *${status.replace('_', ' ')}*.\n\n` +
                `Please complete it on LearnDash before our next class!\n` +
                `🔗 *Class Meeting Link*: ${workshop.meetingLink || 'TBA'}`;

              await this.sendMessage(student.phoneNumber, reminderMsg);
              await logAudit(
                'INFO',
                'SEND_REMINDER',
                `Sent ${reminderCheck.reminderType} reminder to ${student.name} for ${homework.title}`
              );
            }
          } catch (err: any) {
            await logAudit(
              'ERROR',
              'CRON_STUDENT_FAIL',
              `Failed checking progress/reminders for student ${student.name} (ID: ${student.learndashId}): ${err.message}`
            );
          }
        }
      }
    }
  }
}
