import { PrismaClient } from '@prisma/client';
import { IWhatsAppClient, IncomingMessage } from '../interfaces/IWhatsAppClient.js';
import { ILearnDashClient } from '../interfaces/ILearnDashClient.js';
import { ILLMClient } from '../interfaces/ILLMClient.js';
import { logAudit } from './db.js';
import { CONFIG } from '../config/constants.js';
import { resolveLessonsFromText } from '../utils/naturalLanguageParser.js';
import { parseCsvString } from '../utils/csvParser.js';
import { parseDueDate } from '../utils/dateParser.js';

// Submodules
import { ClassManager } from '../modules/classManager/ClassManager.js';
import { HomeworkManager } from '../modules/homeworkManager/HomeworkManager.js';
import { LearnDashSync } from '../modules/learndashSync/LearnDashSync.js';
import { NotificationManager } from '../modules/notificationManager/NotificationManager.js';
import { CommandRouter } from '../modules/commandRouter/CommandRouter.js';

export class OrchestratorService {
  private canceledOnboardings = new Set<string>();

  private classManager: ClassManager;
  private homeworkManager: HomeworkManager;
  private learndashSync: LearnDashSync;
  private notificationManager: NotificationManager;
  private commandRouter: CommandRouter;

  constructor(
    private db: PrismaClient,
    private whatsapp: IWhatsAppClient,
    private learndash: ILearnDashClient,
    private llm: ILLMClient
  ) {
    // Cast/wrap injected services into new interface structures
    this.learndashSync = learndash as any;
    this.classManager = new ClassManager(db, this.learndashSync);
    this.homeworkManager = new HomeworkManager(db);
    this.notificationManager = new NotificationManager(db, this.learndashSync, (jid, text) =>
      this.whatsapp.sendMessage(jid, text)
    );
    this.commandRouter = new CommandRouter(
      db,
      this.classManager,
      this.homeworkManager,
      this.learndashSync,
      this.notificationManager,
      whatsapp
    );
  }

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

    // Listen for manual additions/invite link joins
    this.whatsapp.onGroupParticipantUpdate(async (event) => {
      if (event.action === 'add') {
        try {
          const workshop = await this.db.workshop.findUnique({
            where: { whatsappJid: event.groupJid },
          });
          if (workshop) {
            for (const participant of event.participants) {
              await this.enrollParticipantInDb(workshop.id, participant);
            }
          }
        } catch (err: any) {
          await logAudit('ERROR', 'PARTICIPANT_UPDATE_FAIL', `Failed processing participant join: ${err.message}`, event.groupJid);
        }
      }
    });

    // Sync groups with DB whenever WhatsApp connection successfully opens
    this.whatsapp.onConnectionOpen(() => {
      setTimeout(async () => {
        try {
          await this.syncGroupsWithDb();
        } catch (err: any) {
          console.error('Failed to sync groups on connection open:', err);
        }
      }, CONFIG.WHATSAPP.SYNC_DELAY_MS);
    });

    await logAudit('INFO', 'ORCHESTRATOR_START', 'Orchestrator engine started successfully.');
  }

  /**
   * Syncs existing WhatsApp groups with DB workshops based on matching names.
   */
  async syncGroupsWithDb(): Promise<void> {
    try {
      const groups = await this.whatsapp.getGroups();
      const workshops = await this.db.workshop.findMany();

      for (const workshop of workshops) {
        const matchingGroup = groups.find(
          (g) => g.subject.toLowerCase() === workshop.subject.toLowerCase()
        );

        if (matchingGroup && workshop.whatsappJid !== matchingGroup.id) {
          await this.db.workshop.update({
            where: { id: workshop.id },
            data: { whatsappJid: matchingGroup.id },
          });
          await logAudit(
            'INFO',
            'GROUP_SYNC_LINK',
            `Successfully linked workshop "${workshop.subject}" with WhatsApp group JID ${matchingGroup.id}`
          );
        }
      }
    } catch (err: any) {
      await logAudit('ERROR', 'GROUP_SYNC_FAIL', `Failed syncing groups: ${err.message}`);
    }
  }

  /**
   * Processes incoming WhatsApp messages and delegates to command router
   */
  private async handleMessage(msg: IncomingMessage): Promise<void> {
    const contentDesc = msg.document
      ? `Document: ${msg.document.fileName} (${msg.document.mimetype})`
      : `Text: "${msg.text}"`;

    await logAudit(
      'INFO',
      'WHATSAPP_MESSAGE_RECEIVED',
      `Received message from ${msg.senderJid} (Group: ${msg.isGroup}, Chat JID: ${msg.chatJid}). Content: ${contentDesc}`,
      msg.senderJid
    );

    const targetChatJid = (!msg.isGroup && msg.senderPn) ? msg.senderPn : msg.chatJid;

    // Auto-register the bot's own number as a Teacher in the DB if it is the sender
    const botJid = this.whatsapp.getBotJid();
    const isBotSender = !!(
      (botJid && (msg.senderJid === botJid || (msg.senderPn && msg.senderPn === botJid))) ||
      (msg.rawKey && msg.rawKey.fromMe === true)
    );
    if (isBotSender && botJid) {
      const existingTeacher = await this.db.teacher.findUnique({
        where: { phoneNumber: botJid },
      });
      if (!existingTeacher) {
        await this.db.teacher.create({
          data: {
            name: 'Teacher (Bot)',
            phoneNumber: botJid,
          },
        });
        await logAudit('INFO', 'TEACHER_AUTO_REGISTER', `Automatically registered bot JID ${botJid} as a Teacher.`, botJid);
      }
    }

    // 1. Resolve student sender identity
    let resolvedSenderJid = msg.senderJid;
    const searchSenderJids = [msg.senderJid];
    if (msg.senderPn) {
      searchSenderJids.push(msg.senderPn);
    }

    // 2. Resolve Workshop context based on Group JID, Student Enrollment, or Teacher JID
    let workshop = await this.db.workshop.findFirst({
      where: msg.isGroup
        ? { whatsappJid: msg.chatJid }
        : { teacher: { phoneNumber: { in: searchSenderJids } } },
      include: {
        teacher: true,
        students: { include: { student: true } },
      },
    });

    if (!workshop && !msg.isGroup) {
      const studentEnrollment = await this.db.studentWorkshop.findFirst({
        where: { student: { phoneNumber: { in: searchSenderJids } } },
        include: { workshop: { include: { teacher: true, students: { include: { student: true } } } } },
      });
      if (studentEnrollment) {
        workshop = studentEnrollment.workshop;
      }
    }

    if (!workshop && !msg.isGroup) {
      workshop = await this.db.workshop.findFirst({
        include: {
          teacher: true,
          students: { include: { student: true } },
        },
      });
    }

    const teachers = await this.db.teacher.findMany({ select: { phoneNumber: true } });
    const students = await this.db.student.findMany({ select: { phoneNumber: true } });

    const teacherJids = teachers.map((t) => t.phoneNumber);
    const studentJids = students.map((s) => s.phoneNumber);

    const isWorkshopTeacher = !!(workshop && (msg.senderJid === workshop.teacher.phoneNumber || (msg.senderPn ? msg.senderPn === workshop.teacher.phoneNumber : false)));
    const isTeacher = isWorkshopTeacher || teacherJids.includes(msg.senderJid) || !!(msg.senderPn && teacherJids.includes(msg.senderPn));
    const senderRole = isTeacher ? 'teacher' : 'student';

    // 3. Intercept student profile completion replies in DM
    if (!msg.isGroup && msg.text) {
      const pendingStudent = await this.db.student.findFirst({
        where: {
          phoneNumber: { in: searchSenderJids },
          learndashId: { lt: 0 },
        },
      });

      if (pendingStudent && !this.canceledOnboardings.has(pendingStudent.phoneNumber)) {
        const textClean = msg.text.trim().toLowerCase();
        const isCommand = msg.text.trim().startsWith('/') || msg.text.trim().toLowerCase().startsWith('@bot ');

        if (!isCommand) {
          if (textClean === 'n/a' || textClean === 'cancel') {
            this.canceledOnboardings.add(pendingStudent.phoneNumber);
            await this.whatsapp.sendMessage(targetChatJid, '❌ Profile linking canceled. You can complete it later.');
            return;
          }

          const digitsMatch = msg.text.match(/\b\d+\b/);
          if (digitsMatch) {
            const userId = parseInt(digitsMatch[0], 10);
            const existing = await this.db.student.findUnique({ where: { learndashId: userId } });

            if (existing && existing.id !== pendingStudent.id) {
              await this.whatsapp.sendMessage(
                targetChatJid,
                `❌ Error: LearnDash ID ${userId} is already linked to student *${existing.name}*.`
              );
              return;
            }

            await this.whatsapp.sendMessage(targetChatJid, '⏳ Verifying your User ID against WordPress LearnDash...');
            const verifyRes = await this.learndash.verifyUserId(userId);
            if (verifyRes.exists) {
              await this.db.student.update({
                where: { id: pendingStudent.id },
                data: { learndashId: userId },
              });
              await logAudit('INFO', 'STUDENT_ONBOARDING_LINK_SUCCESS', `Student ${pendingStudent.phoneNumber} linked ID: ${userId}`, msg.senderJid);
              await this.whatsapp.sendMessage(targetChatJid, `✅ Thank you! Your profile is complete. LearnDash ID linked: *${userId}*.`);
            } else {
              await this.whatsapp.sendMessage(
                targetChatJid,
                `❌ Error: We could not find any active account with ID: *${userId}*. Please check your ID and reply again, or reply *N/A* to cancel.\n\n` +
                `ℹ️ *How to find your LearnDash User ID*:\n` +
                `1. Log in to your account at *course.revision.my*\n` +
                `2. Tap on "Profile" (under the menu or avatar).\n` +
                `3. Your User ID is displayed under your profile avatar/name, or visible in your browser profile URL.`
              );
            }
            return;
          } else {
            await this.whatsapp.sendMessage(
              targetChatJid,
              `👋 Need help linking your account?\n\n` +
              `Please reply directly to this message with your *WordPress/LearnDash User ID* (numbers only).\n\n` +
              `ℹ️ *How to find your LearnDash User ID*:\n` +
              `1. Log in to your account at *course.revision.my*\n` +
              `2. Tap on "Profile" (under the menu or avatar).\n` +
              `3. Your User ID is displayed under your profile avatar/name, or visible in your browser profile URL.\n\n` +
              `👉 Reply with your numeric ID (e.g. *12345*), or reply *N/A* to cancel.`
            );
            return;
          }
        }
      }
    }

    // 4. Intercept CSV upload from Teacher
    if (msg.document) {
      const isCsv =
        msg.document.mimetype === 'text/csv' ||
        msg.document.mimetype === 'text/comma-separated-values' ||
        msg.document.fileName.toLowerCase().endsWith('.csv');
      if (isCsv) {
        const teacher = await this.db.teacher.findFirst({
          where: { phoneNumber: { in: searchSenderJids } },
        });
        if (teacher) {
          await this.handleCsvImport(msg, teacher);
          return;
        } else {
          await this.whatsapp.sendMessage(targetChatJid, '⚠️ Unauthorized: Only teachers can perform CSV imports.');
          return;
        }
      }
    }

    // 5. Intercept natural language LearnDash lesson assignments from Teacher
    const isTeacherSender = !!(workshop && isTeacher);
    const isCommand = msg.text && (msg.text.trim().startsWith('/') || msg.text.trim().toLowerCase().startsWith('@bot '));
    if (workshop && msg.text && isTeacherSender && !isCommand) {
      const matchedLessons = resolveLessonsFromText(msg.text, 'data/learndash_cache.json');
      if (matchedLessons.length > 0) {
        const parsedDue = parseDueDate(msg.text);
        const dueDate = parsedDue ? parsedDue.date : new Date();
        if (!parsedDue) {
          dueDate.setDate(dueDate.getDate() + 7);
        }

        const confirmationLines: string[] = [];

        for (const matched of matchedLessons) {
          await this.homeworkManager.assignHomework(workshop.id, matched.lessonId, matched.lessonName, dueDate);
          const auditDetails = `homework detected at ${new Date().toISOString()} with learndash link for lesson ID ${matched.lessonId}`;
          await logAudit('INFO', 'CUSTOM_HOMEWORK_DETECTED', auditDetails, msg.senderJid);
          confirmationLines.push(
            `📖 *Course*: ${matched.courseName}\n` +
            `📝 *Homework*: ${matched.lessonName}\n` +
            `🔗 *Lesson URL*: ${matched.hyperlink}`
          );
        }

        const dueSuffix = parsedDue ? '' : ' (7 days by default)';
        const replyText =
          `✅ *Homework Assigned via LearnDash!*\n\n` +
          confirmationLines.join('\n\n') +
          `\n\n` +
          `📅 *Due Date*: ${dueDate.toDateString()}${dueSuffix}\n\n` +
          `*Bot assistant is now tracking student progress on LearnDash.*`;

        await this.whatsapp.sendMessage(targetChatJid, replyText);
        return;
      }
    }

    // 6. Intercept custom homework due date overrides (only for text-only messages)
    if (workshop && !msg.document && msg.text) {
      const parsed = parseDueDate(msg.text);
      if (parsed) {
        const latestCustomHomework = await this.db.homework.findFirst({
          where: { workshopId: workshop.id, lessonId: { lt: 0 } },
          orderBy: { lessonId: 'asc' }, // Retrieves the most recent (most negative) first
        });

        if (latestCustomHomework) {
          const createdTimestamp = -latestCustomHomework.lessonId;
          const diffSeconds = Math.floor(Date.now() / 1000) - createdTimestamp;

          if (diffSeconds < 600) {
            await this.homeworkManager.assignHomework(
              workshop.id,
              latestCustomHomework.lessonId,
              latestCustomHomework.title,
              parsed.date
            );
            const logMsg = `homework due date updated to ${parsed.reason} for custom homework "${latestCustomHomework.title}"`;
            await logAudit('INFO', 'UPDATE_CUSTOM_HOMEWORK_DUE', logMsg, msg.senderJid);
            await this.whatsapp.sendMessage(
              msg.chatJid,
              `📅 *Homework Due Date Updated!*\n` +
              `The due date for custom homework "${latestCustomHomework.title}" has been updated to: *${parsed.date.toDateString()}*.`
            );
            return;
          }
        }
      }
    }

    // 7. Intercept custom homework document/link upload
    if (workshop) {
      const enrolledStudentJids = workshop.students.map((s) => s.student.phoneNumber);
      const customHomework = await this.homeworkManager.detectCustomHomework(msg, workshop.id, enrolledStudentJids);
      if (customHomework) {
        const replyText =
          `📝 *Custom Homework Assigned!*\n\n` +
          `📖 Task: *${customHomework.title}*\n` +
          `📅 Due Date: ${customHomework.dueDate.toDateString()} (${customHomework.defaultSuffix})\n\n` +
          `*Please complete and submit before the deadline.*`;

        await this.whatsapp.sendMessage(targetChatJid, replyText);
        return;
      }
    }

    // 8. Command Router processing
    const routerResult = await this.commandRouter.executeCommand(msg, senderRole, workshop?.id || null);
    if (routerResult) {
      if (routerResult.shouldDeleteOriginal && msg.rawKey) {
        try {
          await this.whatsapp.deleteMessage(msg.chatJid, msg.rawKey);
        } catch (err: any) {
          await logAudit('WARN', 'WHATSAPP_DELETE_MSG_FAILED', `Failed to delete teacher command message: ${err.message}`, msg.chatJid);
        }
      }
      await this.whatsapp.sendMessage(targetChatJid, routerResult.replyText);
    }
  }

  /**
   * Helper to dynamically enroll a group participant
   */
  private async enrollParticipantInDb(workshopId: string, participantJid: string): Promise<void> {
    const cleanPhone = participantJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const dummyId = parseInt(cleanPhone.slice(-9), 10) || Math.floor(Math.random() * 100000000);
    try {
      let student = await this.db.student.findUnique({
        where: { phoneNumber: participantJid },
      });

      if (!student) {
        student = await this.db.student.create({
          data: {
            name: `Student-${cleanPhone}`,
            phoneNumber: participantJid,
            learndashId: dummyId,
          },
        });
      }

      const enrollment = await this.db.studentWorkshop.findUnique({
        where: {
          studentId_workshopId: {
            studentId: student.id,
            workshopId,
          },
        },
      });

      if (!enrollment) {
        await this.db.studentWorkshop.create({
          data: {
            studentId: student.id,
            workshopId,
          },
        });
        await logAudit('INFO', 'AUTO_ENROLLMENT', `Dynamically enrolled participant ${cleanPhone} to workshop ID ${workshopId}`);
      }
    } catch (err: any) {
      await logAudit('ERROR', 'AUTO_ENROLLMENT_FAILED', `Failed to dynamically enroll ${cleanPhone}: ${err.message}`);
    }
  }

  /**
   * Helper to download, parse, and process CSV rosters
   */
  private async handleCsvImport(msg: IncomingMessage, teacher: any): Promise<void> {
    if (!msg.document) return;

    const targetChatJid = (!msg.isGroup && msg.senderPn) ? msg.senderPn : msg.chatJid;

    try {
      await this.whatsapp.sendMessage(targetChatJid, `⏳ Processing CSV file "${msg.document.fileName}"...`);

      const buffer = await this.whatsapp.downloadDocument(msg.document);
      const csvText = buffer.toString('utf-8');

      const rows = parseCsvString(csvText);
      if (rows.length === 0) {
        await this.whatsapp.sendMessage(targetChatJid, '❌ CSV file is empty or headers are not recognized.');
        return;
      }

      const waGroups = await this.whatsapp.getGroups();
      const summary: Record<string, { added: string[]; failed: string[] }> = {};

      for (const row of rows) {
        for (const targetGroupName of row.groupNames) {
          if (!summary[targetGroupName]) {
            summary[targetGroupName] = { added: [], failed: [] };
          }

          if (!row.isValid) {
            summary[targetGroupName].failed.push(`${row.name} (${row.error || 'Invalid format'})`);
            continue;
          }

          const matchingGroup = waGroups.find(
            (g) => g.subject.toLowerCase() === targetGroupName.toLowerCase()
          );

          if (!matchingGroup) {
            summary[targetGroupName].failed.push(`${row.name} (Group not found)`);
            continue;
          }

          const cleanPhone = row.phone.replace(/\D/g, '');
          const studentJid = `${cleanPhone}@s.whatsapp.net`;

          try {
            await this.whatsapp.addParticipants(matchingGroup.id, [studentJid]);

            let dbWorkshop = await this.db.workshop.findFirst({
              where: { whatsappJid: matchingGroup.id },
            });

            if (!dbWorkshop) {
              dbWorkshop = await this.db.workshop.findFirst({
                where: { subject: { equals: matchingGroup.subject, mode: 'insensitive' } },
              });
              if (dbWorkshop) {
                await this.db.workshop.update({
                  where: { id: dbWorkshop.id },
                  data: { whatsappJid: matchingGroup.id },
                });
              }
            }

            if (dbWorkshop) {
              const dummyId = parseInt(cleanPhone.slice(-9), 10) || Math.floor(Math.random() * 100000000);
              
              const student = await this.db.student.upsert({
                where: { phoneNumber: studentJid },
                create: {
                  name: row.name,
                  phoneNumber: studentJid,
                  learndashId: dummyId,
                },
                update: {
                  name: row.name,
                },
              });

              await this.db.studentWorkshop.upsert({
                where: {
                  studentId_workshopId: {
                    studentId: student.id,
                    workshopId: dbWorkshop.id,
                  },
                },
                create: {
                  studentId: student.id,
                  workshopId: dbWorkshop.id,
                },
                update: {},
              });

              summary[targetGroupName].added.push(row.name);
            } else {
              summary[targetGroupName].failed.push(`${row.name} (Class not registered in bot DB)`);
            }
          } catch (enrollErr: any) {
            summary[targetGroupName].failed.push(`${row.name} (${enrollErr.message || 'WhatsApp error'})`);
          }
        }
      }

      let summaryText = `📊 *Roster CSV Import Summary:*\n`;
      for (const groupName of Object.keys(summary)) {
        const item = summary[groupName];
        summaryText += `\n*Group: ${groupName}*\n` +
          `✅ Added (${item.added.length}): ${item.added.join(', ') || 'None'}\n` +
          `❌ Failed (${item.failed.length}): ${item.failed.join(', ') || 'None'}\n`;
      }

      await this.whatsapp.sendMessage(targetChatJid, summaryText);
    } catch (err: any) {
      await logAudit('ERROR', 'CSV_IMPORT_FAIL', `CSV import failed: ${err.message}`, msg.senderJid);
      await this.whatsapp.sendMessage(targetChatJid, `❌ Failed to import CSV roster: ${err.message}`);
    }
  }

  async compileProgressReport(workshopId: string): Promise<string> {
    return this.commandRouter.compileProgressReport(workshopId);
  }

  async runReminderCron(): Promise<void> {
    await this.notificationManager.runReminderCron();
  }
}
