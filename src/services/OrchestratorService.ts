import { PrismaClient, ProgressStatus } from '@prisma/client';
import { IWhatsAppClient, IncomingMessage } from '../interfaces/IWhatsAppClient.js';
import { ILearnDashClient } from '../interfaces/ILearnDashClient.js';
import { ILLMClient } from '../interfaces/ILLMClient.js';
import { parseCommand } from '../utils/commandParser.js';
import { evaluateProgress } from '../utils/progressEvaluator.js';
import { checkReminderDue } from '../utils/reminderScheduler.js';
import { logAudit } from './db.js';

export class OrchestratorService {
  constructor(
    private db: PrismaClient,
    private whatsapp: IWhatsAppClient,
    private learndash: ILearnDashClient,
    private llm: ILLMClient
  ) {}

  /**
   * Initializes message listeners and starts background cron jobs
   */
  async start(): Promise<void> {
    this.whatsapp.onMessage(async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (err: any) {
        await logAudit('ERROR', 'MESSAGE_HANDLER_FAIL', `Failed to process message: ${err.message}`, msg.senderJid);
      }
    });

    await logAudit('INFO', 'ORCHESTRATOR_START', 'Orchestrator engine started successfully.');
  }

  /**
   * Processes incoming WhatsApp messages and matches them against commands
   */
  private async handleMessage(msg: IncomingMessage): Promise<void> {
    // 1. Resolve Workshop based on Group JID or Teacher JID
    let workshop = await this.db.workshop.findFirst({
      where: msg.isGroup ? { whatsappJid: msg.chatJid } : { teacher: { phoneNumber: msg.senderJid } },
      include: {
        teacher: true,
        students: { include: { student: true } },
      },
    });

    if (!workshop) {
      // If student is DM-ing, find their enrolled workshop
      if (!msg.isGroup) {
        const studentEnrollment = await this.db.studentWorkshop.findFirst({
          where: { student: { phoneNumber: msg.senderJid } },
          include: { workshop: { include: { teacher: true, students: { include: { student: true } } } } },
        });
        if (studentEnrollment) {
          workshop = studentEnrollment.workshop;
        }
      }
    }

    if (!workshop) return; // No active workshop matched for this conversation JID

    // Prepare list of student phone numbers in the workshop
    const studentJids = workshop.students.map(s => s.student.phoneNumber);
    const teacherJid = workshop.teacher.phoneNumber;

    // 2. Parse command
    const parsed = parseCommand(msg.text, msg.senderJid, teacherJid, studentJids);
    if (!parsed) return; // Not a valid command

    // 3. Authorization check
    if (!parsed.isAuthorized) {
      await this.whatsapp.sendMessage(msg.chatJid, '⚠️ Unauthorized command.');
      return;
    }

    // 4. Command Dispatcher
    switch (parsed.command) {
      case 'homework':
        if (parsed.role === 'teacher') {
          await this.handleTeacherHomework(workshop.id, parsed.lessonId, parsed.dueDate!, msg.chatJid);
        } else if (parsed.role === 'student') {
          await this.handleStudentHomeworkList(workshop.id, msg.chatJid);
        }
        break;

      case 'meeting':
      case 'link':
        const meetLink = workshop.meetingLink || 'No class link is configured yet.';
        await this.whatsapp.sendMessage(
          msg.chatJid,
          `📅 *Revision Workshop Meet Link*:\n${meetLink}`
        );
        break;

      case 'report':
        await this.handleTeacherReportRequest(workshop.id, teacherJid);
        break;

      case 'students':
        const studentsList = workshop.students
          .map((s, idx) => `${idx + 1}. ${s.student.name} (${s.student.phoneNumber.split('@')[0]})`)
          .join('\n');
        await this.whatsapp.sendMessage(
          msg.chatJid,
          `📋 *Students Registered (${workshop.students.length}):*\n\n${studentsList || 'None'}`
        );
        break;

      case 'check':
        // Parse student name search from argument
        const searchName = msg.text.substring(msg.text.indexOf('check') + 5).trim();
        await this.handleTeacherStudentCheck(workshop.id, searchName, teacherJid);
        break;

      default:
        break;
    }
  }

  /**
   * Registers a new homework for the workshop and alerts students
   */
  private async handleTeacherHomework(
    workshopId: string,
    lessonId: number | null,
    dueDate: Date,
    chatJid: string
  ): Promise<void> {
    if (!lessonId) {
      await this.whatsapp.sendMessage(chatJid, '❌ Please specify a valid Lesson ID. Format: `/homework <lesson_id>`');
      return;
    }

    // Upsert the homework
    const title = `Lesson ${lessonId} Homework`;
    const homework = await this.db.homework.create({
      data: {
        workshopId,
        lessonId,
        title,
        dueDate,
      },
    });

    await logAudit('INFO', 'CREATE_HOMEWORK', `Teacher created homework for Lesson ID ${lessonId}. Due date: ${dueDate.toDateString()}`);

    // Create initial ProgressLogs for all enrolled students
    const enrollments = await this.db.studentWorkshop.findMany({
      where: { workshopId },
      include: { student: true },
    });

    for (const enrollment of enrollments) {
      await this.db.progressLog.upsert({
        where: {
          studentId_homeworkId: {
            studentId: enrollment.studentId,
            homeworkId: homework.id,
          },
        },
        create: {
          studentId: enrollment.studentId,
          homeworkId: homework.id,
          status: ProgressStatus.NOT_STARTED,
        },
        update: {},
      });
    }

    await this.whatsapp.sendMessage(
      chatJid,
      `✅ *Homework Registered!*\n\n` +
      `📖 *Homework*: ${title}\n` +
      `📅 *Due Date*: ${dueDate.toDateString()} (in 7 days)\n\n` +
      `*Bot assistant is now tracking student progress on LearnDash.*`
    );
  }

  /**
   * Students query pending homework
   */
  private async handleStudentHomeworkList(workshopId: string, replyJid: string): Promise<void> {
    const homeworks = await this.db.homework.findMany({
      where: { workshopId, dueDate: { gte: new Date() } },
      orderBy: { dueDate: 'asc' },
    });

    if (homeworks.length === 0) {
      await this.whatsapp.sendMessage(replyJid, '🎉 You have no pending homework tasks!');
      return;
    }

    const listText = homeworks
      .map(h => `- *${h.title}* (Due: ${h.dueDate.toDateString()})`)
      .join('\n');

    await this.whatsapp.sendMessage(replyJid, `📖 *Your Pending Homework Tasks:*\n\n${listText}`);
  }

  /**
   * Teachers trigger report generation
   */
  private async handleTeacherReportRequest(workshopId: string, teacherJid: string): Promise<void> {
    const reportText = await this.compileProgressReport(workshopId);
    await this.whatsapp.sendMessage(teacherJid, reportText);
    await logAudit('INFO', 'SEND_MANUAL_REPORT', 'Sent progress report directly to teacher.', teacherJid);
  }

  /**
   * Check a specific student's status
   */
  private async handleTeacherStudentCheck(
    workshopId: string,
    searchName: string,
    teacherJid: string
  ): Promise<void> {
    if (!searchName) {
      await this.whatsapp.sendMessage(teacherJid, '❌ Please specify student name. Format: `/check <student_name>`');
      return;
    }

    const enrollment = await this.db.studentWorkshop.findFirst({
      where: {
        workshopId,
        student: { name: { contains: searchName, mode: 'insensitive' } },
      },
      include: {
        student: {
          include: {
            progress: {
              include: { homework: true },
            },
          },
        },
      },
    });

    if (!enrollment) {
      await this.whatsapp.sendMessage(teacherJid, `❌ No student found matching "${searchName}" in this class.`);
      return;
    }

    const student = enrollment.student;
    const progressLines = student.progress.length === 0 
      ? 'No active homework logs.'
      : student.progress
          .map(p => `- *${p.homework.title}*: ${p.status} (Score: ${p.score ?? 'N/A'})`)
          .join('\n');

    await this.whatsapp.sendMessage(
      teacherJid,
      `👤 *Student Audit: ${student.name}*\n` +
      `📞 Phone: ${student.phoneNumber.split('@')[0]}\n` +
      `🆔 LearnDash ID: ${student.learndashId}\n\n` +
      `*Progress History:*\n${progressLines}`
    );
  }

  /**
   * Pulls fresh LearnDash stats, updates DB logs, and sends reminders if due
   */
  async runReminderCron(): Promise<void> {
    const now = new Date();
    await logAudit('INFO', 'RUN_REMINDER_CRON', 'Starting progress validation and reminder cycle.');

    // Fetch all active workshops
    const workshops = await this.db.workshop.findMany({
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
            // 1. Fetch live course progress from WordPress LearnDash API
            const progressData = await this.learndash.getStudentCourseProgress(student.learndashId, workshop.courseId);
            
            // 2. Evaluate status
            const status = evaluateProgress(progressData, homework.lessonId);

            // 3. Update Progress Log in DB
            const log = await this.db.progressLog.upsert({
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

            // 4. Send reminder if due and incomplete
            if (reminderCheck.shouldSend && status !== ProgressStatus.COMPLETED) {
              const reminderMsg =
                `🔔 *HOMEWORK REMINDER* 🔔\n\n` +
                `Hi *${student.name}*,\n` +
                `This is an assistant reminder for *${workshop.subject}*.\n\n` +
                `You have not completed the homework: *${homework.title}*.\n` +
                `Your current status is: *${status.replace('_', ' ')}*.\n\n` +
                `Please complete it on LearnDash before our next class!\n` +
                `🔗 *Class Meeting Link*: ${workshop.meetingLink || 'TBA'}`;

              await this.whatsapp.sendMessage(student.phoneNumber, reminderMsg);
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

  /**
   * Compiles a localized formatted progress report without utilizing LLM tokens
   */
  private async compileProgressReport(workshopId: string): Promise<string> {
    const workshop = await this.db.workshop.findUnique({
      where: { id: workshopId },
      include: {
        teacher: true,
        homeworks: {
          orderBy: { dueDate: 'desc' },
          take: 1, // Look at latest homework
          include: {
            progress: {
              include: { student: true },
            },
          },
        },
      },
    });

    if (!workshop || workshop.homeworks.length === 0) {
      return '📋 *Class Progress Report*:\nNo homework logs found for this workshop.';
    }

    const latestHomework = workshop.homeworks[0];
    const logs = latestHomework.progress;
    
    const total = logs.length;
    const completed = logs.filter(l => l.status === ProgressStatus.COMPLETED).length;
    const skipped = logs.filter(l => l.status === ProgressStatus.SKIPPED_EXERCISES).length;
    const inProgress = logs.filter(l => l.status === ProgressStatus.IN_PROGRESS).length;
    const notStarted = logs.filter(l => l.status === ProgressStatus.NOT_STARTED).length;

    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    let detailsList = '';
    for (const log of logs) {
      let statusIcon = '🔴';
      if (log.status === ProgressStatus.COMPLETED) statusIcon = '🟢';
      if (log.status === ProgressStatus.IN_PROGRESS) statusIcon = '🟡';
      if (log.status === ProgressStatus.SKIPPED_EXERCISES) statusIcon = '🟠';

      detailsList += `${statusIcon} *${log.student.name}* : ${log.status.replace('_', ' ')}\n`;
    }

    return (
      `📈 *Class Progress Report: ${workshop.subject}* 📈\n` +
      `📖 Homework: *${latestHomework.title}*\n` +
      `📅 Due Date: ${latestHomework.dueDate.toDateString()}\n\n` +
      `📊 *Stats Summary:*\n` +
      `- Completion Rate: *${completionRate}%*\n` +
      `- Completed: ${completed} 🟢\n` +
      `- Skipped Exercises: ${skipped} 🟠\n` +
      `- In Progress: ${inProgress} 🟡\n` +
      `- Not Started: ${notStarted} 🔴\n\n` +
      `📋 *Detailed Student Progress Status:*\n\n${detailsList}`
    );
  }
}
