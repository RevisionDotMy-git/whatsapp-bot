import { PrismaClient, ProgressStatus } from '@prisma/client';
import { IWhatsAppClient, IncomingMessage } from '../interfaces/IWhatsAppClient.js';
import { ILearnDashClient } from '../interfaces/ILearnDashClient.js';
import { ILLMClient } from '../interfaces/ILLMClient.js';
import { parseCommand } from '../utils/commandParser.js';
import { evaluateProgress } from '../utils/progressEvaluator.js';
import { checkReminderDue } from '../utils/reminderScheduler.js';
import { parseCsvString } from '../utils/csvParser.js';
import { logAudit } from './db.js';
import { CONFIG } from '../config/constants.js';
import { resolveLessonsFromText } from '../utils/naturalLanguageParser.js';
import { COMMANDS } from '../utils/commandRegistry.js';
import fs from 'fs';

interface ParsedDueDate {
  date: Date;
  reason: string;
}

function parseDueDate(text: string | null | undefined): ParsedDueDate | null {
  if (!text) return null;
  const textLower = text.toLowerCase().trim();
  const tomorrowMatch = textLower.match(/(?:this homework due|due|by|before)?\s*tomorrow/i);
  const nextWeekMatch = textLower.match(/(?:this homework due|due|by|before)?\s*next\s*[-]?\s*week/i);
  const nextMonthMatch = textLower.match(/(?:this homework due|due|by|before)?\s*next\s*[-]?\s*month/i);
  const relativeMatch = text.match(/(?:this homework due|due|by|before)\s+(\d+)\s+days?/i);
  const dateMatch = text.match(/(?:complete\s+it\s+before|before|due|by)\s+(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?/i);

  if (tomorrowMatch && !relativeMatch && !dateMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return { date: d, reason: 'tomorrow' };
  } else if (nextWeekMatch && !relativeMatch && !dateMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return { date: d, reason: 'next week' };
  } else if (nextMonthMatch && !relativeMatch && !dateMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return { date: d, reason: 'next month' };
  } else if (relativeMatch) {
    const days = parseInt(relativeMatch[1], 10);
    const d = new Date();
    d.setDate(d.getDate() + days);
    return { date: d, reason: `${days} days` };
  } else if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10) - 1; // 0-indexed month
    let year = dateMatch[3] ? parseInt(dateMatch[3], 10) : new Date().getFullYear();
    if (year < 100) {
      year += 2000;
    }
    const d = new Date(year, month, day, 23, 59, 59);
    if (!isNaN(d.getTime())) {
      return { date: d, reason: `${day}/${month + 1}/${year}` };
    }
  }
  return null;
}

export class OrchestratorService {
  private canceledOnboardings = new Set<string>();

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
      // Add a configurable delay to let the socket stabilize and finish initial sync before fetching groups
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
   * Syncs existing participating WhatsApp groups with database workshops based on matching names.
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
   * Processes incoming WhatsApp messages and matches them against commands
   */
  private async handleMessage(msg: IncomingMessage): Promise<void> {
    // Log the incoming message to database audit log
    const contentDesc = msg.document 
      ? `Document: ${msg.document.fileName} (${msg.document.mimetype})`
      : `Text: "${msg.text}"`;
    
    await logAudit(
      'INFO',
      'WHATSAPP_MESSAGE_RECEIVED',
      `Received message from ${msg.senderJid} (Group: ${msg.isGroup}, Chat JID: ${msg.chatJid}). Content: ${contentDesc}`,
      msg.senderJid
    );

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
        await logAudit('INFO', 'TEACHER_AUTO_REGISTER', `Automatically registered bot JID ${botJid} as a Teacher in the database.`, botJid);
      }
    }

    // Intercept student profile completion replies in DM
    if (!msg.isGroup && msg.text) {
      const searchSenderJids = [msg.senderJid];
      if (msg.senderPn) {
        searchSenderJids.push(msg.senderPn);
      }

      // Check if student has a pending onboarding JID
      const pendingStudent = await this.db.student.findFirst({
        where: {
          phoneNumber: { in: searchSenderJids },
          learndashId: { lt: 0 } // Negative indicates pending
        }
      });

      if (pendingStudent && !this.canceledOnboardings.has(pendingStudent.phoneNumber)) {
        const textClean = msg.text.trim().toLowerCase();
        const isCommand = msg.text.trim().startsWith('/') || msg.text.trim().toLowerCase().startsWith('@bot ');

        if (!isCommand) {
          if (textClean === 'n/a' || textClean === 'cancel') {
            this.canceledOnboardings.add(pendingStudent.phoneNumber);
            await this.whatsapp.sendMessage(msg.chatJid, '❌ Profile linking canceled. You can complete it later or ask your teacher to link it.');
            return;
          }

          // Try to parse digit ID
          const digitsMatch = msg.text.match(/\b\d+\b/);
          if (digitsMatch) {
            const userId = parseInt(digitsMatch[0], 10);
            
            // Check if already in use
            const existing = await this.db.student.findUnique({
              where: { learndashId: userId }
            });

            if (existing && existing.id !== pendingStudent.id) {
              await this.whatsapp.sendMessage(
                msg.chatJid,
                `❌ Error: LearnDash ID ${userId} is already linked to student *${existing.name}*. Please double-check your ID or contact your teacher.`
              );
              return;
            }

            await this.whatsapp.sendMessage(msg.chatJid, '⏳ Verifying your User ID against WordPress LearnDash...');
            
            const verifyRes = await this.learndash.verifyUserId(userId);
            if (verifyRes.exists) {
              await this.db.student.update({
                where: { id: pendingStudent.id },
                data: { learndashId: userId }
              });
              await logAudit('INFO', 'STUDENT_ONBOARDING_LINK_SUCCESS', `Student ${pendingStudent.phoneNumber} linked LearnDash ID: ${userId}`, msg.senderJid);
              await this.whatsapp.sendMessage(msg.chatJid, `✅ Thank you! Your profile is complete. LearnDash ID linked: *${userId}*.`);
            } else {
              if (verifyRes.error) {
                await this.whatsapp.sendMessage(msg.chatJid, `⚠️ Verification connection error. We could not verify your ID with the LearnDash server right now. Please try again in a few minutes.`);
              } else {
                await this.whatsapp.sendMessage(
                  msg.chatJid,
                  `❌ Error: We could not find any active account with ID: *${userId}*. Please check your ID and reply again, or reply *N/A* to cancel.\n\n` +
                  `ℹ️ *How to find your LearnDash User ID*:\n` +
                  `1. Log in to your account at *course.revision.my*\n` +
                  `2. Tap on "Profile" (under the menu or avatar).\n` +
                  `3. Your User ID is displayed under your profile avatar/name, or visible in your browser profile URL.`
                );
              }
            }
            return;
          } else {
            // Send guide since no digits matched and not cancel
            await this.whatsapp.sendMessage(
              msg.chatJid,
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

    // Intercept CSV upload from Teacher
    if (msg.document) {
      const isCsv = msg.document.mimetype === 'text/csv' || 
                    msg.document.mimetype === 'text/comma-separated-values' || 
                    msg.document.fileName.endsWith('.csv');
      if (isCsv) {
        const searchTeacherJids = [msg.senderJid];
        if (msg.senderPn) {
          searchTeacherJids.push(msg.senderPn);
        }
        const teacher = await this.db.teacher.findFirst({
          where: { phoneNumber: { in: searchTeacherJids } },
        });
        if (teacher) {
          await this.handleCsvImport(msg, teacher);
          return;
        } else {
          await this.whatsapp.sendMessage(msg.chatJid, '⚠️ Unauthorized: Only teachers can perform CSV imports.');
          return;
        }
      }
    }

    const searchSenderJids = [msg.senderJid];
    if (msg.senderPn) {
      searchSenderJids.push(msg.senderPn);
    }

    // 1. Resolve Workshop based on Group JID or Teacher JID
    let workshop = await this.db.workshop.findFirst({
      where: msg.isGroup 
        ? { whatsappJid: msg.chatJid } 
        : { teacher: { phoneNumber: { in: searchSenderJids } } },
      include: {
        teacher: true,
        students: { include: { student: true } },
      },
    });

    if (!workshop) {
      if (msg.isGroup) {
        // If we couldn't find the workshop by JID, try to sync groups right now to see if this is a newly linked group!
        await this.syncGroupsWithDb();
        workshop = await this.db.workshop.findFirst({
          where: { whatsappJid: msg.chatJid },
          include: {
            teacher: true,
            students: { include: { student: true } },
          },
        });
      } else {
        // If student is DM-ing, find their enrolled workshop
        const studentEnrollment = await this.db.studentWorkshop.findFirst({
          where: {
            student: {
              phoneNumber: { in: searchSenderJids },
            },
          },
          include: { workshop: { include: { teacher: true, students: { include: { student: true } } } } },
        });
        if (studentEnrollment) {
          workshop = studentEnrollment.workshop;
        }
      }
    }

    // Fallback: If still no workshop resolved, get the first available workshop in database (crucial for DM testing)
    if (!workshop && !msg.isGroup) {
      workshop = await this.db.workshop.findFirst({
        include: {
          teacher: true,
          students: { include: { student: true } },
        },
      });
    }

    if (!workshop) {
      if (msg.isGroup) {
        await logAudit(
          'WARN',
          'WORKSHOP_NOT_FOUND',
          `Could not resolve workshop for sender ${msg.senderJid} or chat ${msg.chatJid}`,
          msg.senderJid
        );
      }
    } else {
      await logAudit(
        'INFO',
        'WORKSHOP_MATCHED',
        `Resolved workshop "${workshop.subject}" (ID: ${workshop.id}) for chat ${msg.chatJid}`,
        msg.senderJid
      );
    }

    // Check for natural language LearnDash homework assignment from Teacher
    const isTeacherSender = workshop && (msg.senderJid === workshop.teacher.phoneNumber || (msg.senderPn && msg.senderPn === workshop.teacher.phoneNumber));
    if (workshop && msg.text && isTeacherSender) {
      const matchedLessons = resolveLessonsFromText(msg.text, 'data/learndash_cache.json');
      if (matchedLessons.length > 0) {
        // Calculate due date once for the entire message
        const parsedDue = parseDueDate(msg.text);
        const dueDate = parsedDue ? parsedDue.date : new Date();
        if (!parsedDue) {
          dueDate.setDate(dueDate.getDate() + 7); // Default 7 days
        }

        const confirmationLines: string[] = [];

        for (const matched of matchedLessons) {
          // Check if homework already exists for this workshop and lesson
          let homework = await this.db.homework.findFirst({
            where: {
              workshopId: workshop.id,
              lessonId: matched.lessonId
            }
          });

          if (!homework) {
            homework = await this.db.homework.create({
              data: {
                workshopId: workshop.id,
                lessonId: matched.lessonId,
                title: matched.lessonName,
                dueDate
              }
            });

            // Create initial ProgressLogs for all enrolled students
            const enrollments = await this.db.studentWorkshop.findMany({
              where: { workshopId: workshop.id },
              include: { student: true }
            });

            for (const enrollment of enrollments) {
              await this.db.progressLog.upsert({
                where: {
                  studentId_homeworkId: {
                    studentId: enrollment.studentId,
                    homeworkId: homework.id
                  }
                },
                create: {
                  studentId: enrollment.studentId,
                  homeworkId: homework.id,
                  status: 'NOT_STARTED'
                },
                update: {}
              });
            }

            const auditDetails = `homework detected at ${new Date().toISOString()} with learndash link for lesson ID ${matched.lessonId}`;
            await logAudit('INFO', 'CUSTOM_HOMEWORK_DETECTED', auditDetails, msg.senderJid);
          } else {
            // Update due date if already exists
            await this.db.homework.update({
              where: { id: homework.id },
              data: { dueDate }
            });
            
            const auditDetails = `homework due date updated to ${dueDate.toDateString()} for lesson ID ${matched.lessonId}`;
            await logAudit('INFO', 'UPDATE_CUSTOM_HOMEWORK_DUE', auditDetails, msg.senderJid);
          }

          confirmationLines.push(
            `📖 *Course*: ${matched.courseName}\n` +
            `📝 *Homework*: ${matched.lessonName}\n` +
            `🔗 *Lesson URL*: ${matched.hyperlink}`
          );
        }

        const dueSuffix = parsedDue ? '' : ' (7 days by default)';
        const replyText = 
          `✅ *Homework Assigned via LearnDash!*\n\n` +
          confirmationLines.join('\n\n') + `\n\n` +
          `📅 *Due Date*: ${dueDate.toDateString()}${dueSuffix}\n\n` +
          `*Bot assistant is now tracking student progress on LearnDash.*`;

        await this.whatsapp.sendMessage(msg.chatJid, replyText);
        return; // Stop processing
      }
    }

    // Check if the message contains a Google Drive link
    const googleLinkRegex = /(?:docs|drive|sheets|forms|slides)\.google\.com/i;
    const hasGoogleLink = !!(msg.text && (googleLinkRegex.test(msg.text) || msg.text.includes('google.com/document') || msg.text.includes('google.com/file')));

    // Handle Custom Homework due date overrides (only for text-only messages without Google Drive links)
    if (workshop && !msg.document && !hasGoogleLink) {
      const parsed = parseDueDate(msg.text);
      if (parsed) {
        // Find the latest custom homework (lessonId < 0) for this workshop
        const latestCustomHomework = await this.db.homework.findFirst({
          where: {
            workshopId: workshop.id,
            lessonId: { lt: 0 }
          },
          orderBy: {
            lessonId: 'asc' // Ascending puts the most negative (most recent) first
          }
        });

        if (latestCustomHomework) {
          const createdTimestampSeconds = -latestCustomHomework.lessonId;
          const currentTimestampSeconds = Math.floor(Date.now() / 1000);
          const diffSeconds = currentTimestampSeconds - createdTimestampSeconds;

          // If created in the last 10 minutes
          if (diffSeconds < 600) {
            await this.db.homework.update({
              where: { id: latestCustomHomework.id },
              data: { dueDate: parsed.date }
            });

            const logMsg = `homework due date updated to ${parsed.reason} for custom homework "${latestCustomHomework.title}"`;
            await logAudit('INFO', 'UPDATE_CUSTOM_HOMEWORK_DUE', logMsg, msg.senderJid);

            await this.whatsapp.sendMessage(
              msg.chatJid,
              `📅 *Homework Due Date Updated!*\n` +
              `The due date for custom homework "${latestCustomHomework.title}" has been updated to: *${parsed.date.toDateString()}*.`
            );
            return; // Stop processing
          }
        }
      }
    }

    // Detect new custom homework file/link
    let fileFormat: string | null = null;
    if (msg.document) {
      const fileNameLower = (msg.document.fileName || '').toLowerCase();
      const mimeLower = (msg.document.mimetype || '').toLowerCase();
      if (fileNameLower.endsWith('.pdf') || mimeLower === 'application/pdf') {
        fileFormat = 'pdf';
      } else if (
        fileNameLower.endsWith('.docx') || 
        mimeLower === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimeLower === 'application/msword'
      ) {
        fileFormat = 'docx';
      }
      
      await logAudit(
        'INFO',
        'DOCUMENT_ANALYSIS',
        `Analyzing document: name="${msg.document.fileName}", mime="${msg.document.mimetype}". fileFormat matched: ${fileFormat || 'NONE'}`,
        msg.senderJid
      );
    } else if (msg.text) {
      if (hasGoogleLink) {
        fileFormat = 'drive link';
      }
      
      if (fileFormat) {
        await logAudit(
          'INFO',
          'LINK_ANALYSIS',
          `Matched Google Drive link in text. fileFormat matched: ${fileFormat}`,
          msg.senderJid
        );
      }
    }

    if (fileFormat && workshop) {
      const timestampSeconds = Math.floor(Date.now() / 1000);
      const customLessonId = -timestampSeconds; // Negative lessonId as unique key and timestamp
      const title = `Custom Homework (${fileFormat})`;
      
      // Parse due date from caption/text, default to 7 days if none or failed
      const parsed = parseDueDate(msg.text);
      const dueDate = parsed ? parsed.date : new Date();
      if (!parsed) {
        dueDate.setDate(dueDate.getDate() + 7); // Default 7 days
      }

      const homework = await this.db.homework.create({
        data: {
          workshopId: workshop.id,
          lessonId: customLessonId,
          title,
          dueDate
        }
      });

      // Log exactly: homework detected at [timestamp] with [file_format (pdf, docx, or drive link)]
      const auditLogDetails = `homework detected at ${new Date().toISOString()} with ${fileFormat}`;
      await logAudit('INFO', 'CUSTOM_HOMEWORK_DETECTED', auditLogDetails, msg.senderJid);

      // Create initial ProgressLogs for all enrolled students in the workshop so it shows up in WebUI correctly
      const enrollments = await this.db.studentWorkshop.findMany({
        where: { workshopId: workshop.id },
        include: { student: true }
      });

      for (const enrollment of enrollments) {
        await this.db.progressLog.upsert({
          where: {
            studentId_homeworkId: {
              studentId: enrollment.studentId,
              homeworkId: homework.id
            }
          },
          create: {
            studentId: enrollment.studentId,
            homeworkId: homework.id,
            status: 'NOT_STARTED'
          },
          update: {}
        });
      }

      const defaultSuffix = parsed ? '' : ' (7 days by default)';
      await this.whatsapp.sendMessage(
        msg.chatJid,
        `📝 *Custom Homework Detected!*\n\n` +
        `📂 *Type*: ${fileFormat.toUpperCase()}\n` +
        `📅 *Due Date*: ${dueDate.toDateString()}${defaultSuffix}\n\n` +
        `_You can reply with "this homework due 3 days" or "before DD/MM" to override the due date._`
      );

      return; // Stop processing
    }

    // Self-healing enrollment: if group message from someone in the group but not in DB
    if (msg.isGroup && workshop) {
      const isEnrolled = workshop.students.some(
        s => s.student.phoneNumber === msg.senderJid || (msg.senderPn && s.student.phoneNumber === msg.senderPn)
      );
      const isTeacher = workshop.teacher.phoneNumber === msg.senderJid || (msg.senderPn && workshop.teacher.phoneNumber === msg.senderPn);
      if (!isEnrolled && !isTeacher) {
        await this.enrollParticipantInDb(workshop.id, msg.senderPn || msg.senderJid);
        // Refresh workshop with new student enrolled so command parsing role checks work!
        const refreshedWorkshop = await this.db.workshop.findFirst({
          where: { id: workshop.id },
          include: {
            teacher: true,
            students: { include: { student: true } },
          },
        });
        if (refreshedWorkshop) {
          workshop = refreshedWorkshop;
        }
      }
    }

    // Determine global roles based on database records
    const checkJids = [msg.senderJid];
    if (msg.senderPn) {
      checkJids.push(msg.senderPn);
    }
    const isGlobalTeacher = await this.db.teacher.findFirst({
      where: { phoneNumber: { in: checkJids } }
    });
    const isGlobalStudent = await this.db.student.findFirst({
      where: { phoneNumber: { in: checkJids } }
    });

    // Prepare list of student phone numbers in the workshop and teacher JID
    const studentJids = workshop ? workshop.students.map(s => s.student.phoneNumber) : [];
    if (isGlobalStudent && !studentJids.includes(isGlobalStudent.phoneNumber)) {
      studentJids.push(isGlobalStudent.phoneNumber);
    }
    const teacherJid = workshop ? workshop.teacher.phoneNumber : (isGlobalTeacher ? isGlobalTeacher.phoneNumber : '');

    // Collect all valid teacher JIDs to authorize command parsing (including bot's own JID)
    const teacherJids: string[] = [];
    if (teacherJid) {
      teacherJids.push(teacherJid);
    }
    if (isGlobalTeacher && !teacherJids.includes(isGlobalTeacher.phoneNumber)) {
      teacherJids.push(isGlobalTeacher.phoneNumber);
    }
    if (botJid && !teacherJids.includes(botJid)) {
      teacherJids.push(botJid);
    }
    if (isBotSender && !teacherJids.includes(msg.senderJid)) {
      teacherJids.push(msg.senderJid);
    }

    // Determine the normalized sender JID to match database records
    let resolvedSenderJid = msg.senderJid;
    if (isGlobalTeacher) {
      resolvedSenderJid = isGlobalTeacher.phoneNumber;
    } else if (isGlobalStudent) {
      resolvedSenderJid = isGlobalStudent.phoneNumber;
    } else if (workshop) {
      const isTeacherSenderJid = msg.senderJid === teacherJid || (msg.senderPn && msg.senderPn === teacherJid);
      if (isTeacherSenderJid) {
        resolvedSenderJid = teacherJid;
      } else {
        const matchedStudent = workshop.students.find(
          s => s.student.phoneNumber === msg.senderJid || (msg.senderPn && s.student.phoneNumber === msg.senderPn)
        );
        if (matchedStudent) {
          resolvedSenderJid = matchedStudent.student.phoneNumber;
        }
      }
    }

    // 2. Parse command
    const parsed = parseCommand(msg.text, resolvedSenderJid, teacherJids, studentJids);
    if (!parsed) {
      // Non-command messages require workshop context to proceed to natural language parsing or custom homework
      if (!workshop) return;
      return; 
    }

    // 3. Authorization check
    if (!parsed.isAuthorized) {
      await this.whatsapp.sendMessage(msg.chatJid, '⚠️ Unauthorized command.');
      return;
    }

    // 3b. Argument validation check from registry
    if (!parsed.isValid) {
      await this.whatsapp.sendMessage(msg.chatJid, `❌ ${parsed.validationError || 'Invalid command usage.'}`);
      return;
    }

    // Delete teacher command messages in group chats to maintain student UI/UX
    if (msg.isGroup && parsed.role === 'teacher' && msg.rawKey) {
      try {
        await this.whatsapp.deleteMessage(msg.chatJid, msg.rawKey);
      } catch (err: any) {
        await logAudit('WARN', 'WHATSAPP_DELETE_MSG_FAILED', `Failed to delete teacher command message: ${err.message}`, msg.chatJid);
      }
    }

    // 4. Command Dispatcher
    switch (parsed.command) {
      case 'help':
        await this.handleHelp(parsed.role, msg.chatJid);
        break;

      case 'invite':
        await this.handleTeacherInvite(msg, msg.chatJid);
        break;

      case 'add':
        await this.handleTeacherAddStudent(msg, msg.chatJid);
        break;

      case 'profile':
        await this.handleTeacherProfileUpdate(msg, msg.chatJid);
        break;

      case 'homework':
        if (!workshop) {
          await this.whatsapp.sendMessage(msg.chatJid, '❌ This command requires a workshop context.');
          return;
        }
        if (parsed.role === 'teacher') {
          const isDelete = parsed.args[0] && parsed.args[0].toLowerCase() === 'delete';
          if (isDelete) {
            await this.handleTeacherHomeworkDelete(workshop.id, parsed.lessonId, msg.chatJid);
          } else {
            await this.handleTeacherHomework(workshop.id, parsed.lessonId, parsed.dueDate!, msg.chatJid, parsed.args.join(' '));
          }
        } else if (parsed.role === 'student') {
          const textParts = msg.text.trim().split(/\s+/);
          const subCommand = (textParts[1] || '').toLowerCase();
          if (subCommand === 'done') {
            await this.handleStudentHomeworkDone(workshop.id, resolvedSenderJid, msg.chatJid);
          } else {
            await this.handleStudentHomeworkList(workshop.id, resolvedSenderJid, msg.chatJid);
          }
        }
        break;

      case 'meeting':
        if (parsed.role === 'teacher' && parsed.args.length > 0) {
          // Parse meeting arguments: [create] [<class_subject>] [<link>]
          let argsToProcess = parsed.args;
          if (argsToProcess[0]?.toLowerCase() === 'create') {
            argsToProcess = argsToProcess.slice(1);
          }

          const linkIndex = argsToProcess.findIndex(arg => arg.startsWith('http://') || arg.startsWith('https://'));
          let link: string | null = null;
          let classSubject = '';

          if (linkIndex !== -1) {
            link = argsToProcess[linkIndex];
            classSubject = argsToProcess.slice(0, linkIndex).join(' ').trim();
          } else {
            classSubject = argsToProcess.join(' ').trim();
          }

          let targetWorkshop = workshop;
          if (classSubject) {
            targetWorkshop = await this.db.workshop.findFirst({
              where: { subject: { contains: classSubject, mode: 'insensitive' } },
              include: { teacher: true, students: { include: { student: true } } }
            });
            if (!targetWorkshop) {
              await this.whatsapp.sendMessage(msg.chatJid, `❌ Workshop with subject "${classSubject}" not found.`);
              return;
            }
          }

          if (!targetWorkshop) {
            await this.whatsapp.sendMessage(
              msg.chatJid,
              '❌ In a private chat, please specify the class subject. Usage: `/meeting [create] <class_subject> [<link>]`'
            );
            return;
          }

          // If no link is provided, generate a Google Meet link
          if (!link) {
            const letters = 'abcdefghijklmnopqrstuvwxyz';
            const randSegment = (len: number) => Array.from({ length: len }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
            link = `https://meet.google.com/${randSegment(3)}-${randSegment(4)}-${randSegment(3)}`;
          }

          // Update meeting link
          await this.db.workshop.update({
            where: { id: targetWorkshop.id },
            data: { meetingLink: link }
          });

          await logAudit('INFO', 'UPDATE_MEETING_LINK', `Teacher updated meeting link for workshop ${targetWorkshop.subject} to ${link}`, msg.senderJid);
          
          await this.whatsapp.sendMessage(
            msg.chatJid,
            `✅ Meeting link updated for *${targetWorkshop.subject}*:\n${link}`
          );

          if (targetWorkshop.whatsappJid) {
            await this.whatsapp.sendMessage(
              targetWorkshop.whatsappJid,
              `📅 *Class Meeting Link Update*:\nThe meeting link for *${targetWorkshop.subject}* has been updated to:\n${link}`
            );
          }
        } else {
          // Display the link
          if (!workshop) {
            await this.whatsapp.sendMessage(msg.chatJid, '❌ This command requires a workshop context.');
            return;
          }
          const meetLink = workshop.meetingLink || 'No class link is configured yet.';
          await this.whatsapp.sendMessage(
            msg.chatJid,
            `📅 *Revision Workshop Meet Link*:\n${meetLink}`
          );
        }
        break;

      case 'link':
        if (parsed.role === 'student' && parsed.args.length > 0) {
          const rawId = parsed.args[0];
          const userId = parseInt(rawId, 10);
          if (isNaN(userId) || userId <= 0) {
            await this.whatsapp.sendMessage(msg.chatJid, '❌ LearnDash User ID must be a positive integer.');
            return;
          }
          await this.handleDirectStudentLink(resolvedSenderJid, userId, msg.chatJid);
        } else {
          await this.whatsapp.sendMessage(
            msg.chatJid,
            `ℹ️ *How to link your WordPress/LearnDash User ID*:\n\n` +
            `1. Log in to your account at *course.revision.my*\n` +
            `2. Tap on "Profile" (under the menu or avatar).\n` +
            `3. Locate your numeric *User ID* (displayed under your profile avatar/name, or visible in your browser profile URL).\n` +
            `4. Send a Direct Message (DM) to this bot containing only your numeric ID (e.g. *12345*), or run \`/link <id>\` in chat.\n\n` +
            `*Note*: If you cannot find your ID, please contact your teacher to link it for you using \`/profile <phone> id <id>\`.`
          );
        }
        break;

      case 'unlink':
        if (parsed.role === 'teacher') {
          if (parsed.args.length === 0) {
            await this.whatsapp.sendMessage(msg.chatJid, '❌ Please specify the student phone number to unlink. Usage: `/unlink <phone>`');
            return;
          }
          await this.handleTeacherUnlink(parsed.args[0], msg.chatJid);
        } else if (parsed.role === 'student') {
          await this.handleStudentUnlink(resolvedSenderJid, msg.chatJid);
        }
        break;

      case 'remove':
        await this.handleTeacherRemove(msg, msg.chatJid);
        break;

      case 'class':
        await this.handleTeacherClassCRUD(parsed.args, msg.chatJid);
        break;

      case 'report':
        await this.handleTeacherReportAdvanced(parsed.args, msg.senderJid, msg.chatJid, workshop);
        break;

      case 'students':
        if (!workshop) {
          await this.whatsapp.sendMessage(msg.chatJid, '❌ This command requires a workshop context.');
          return;
        }
        const studentsList = workshop.students
          .map((s, idx) => `${idx + 1}. ${s.student.name} (${s.student.phoneNumber.split('@')[0]})`)
          .join('\n');
        await this.whatsapp.sendMessage(
          msg.chatJid,
          `📋 *Students Registered (${workshop.students.length}):*\n\n${studentsList || 'None'}`
        );
        break;

      case 'check':
        if (!workshop) {
          await this.whatsapp.sendMessage(msg.chatJid, '❌ This command requires a workshop context.');
          return;
        }
        // Parse student name search from argument
        const searchName = msg.text.substring(msg.text.indexOf('check') + 5).trim();
        await this.handleTeacherStudentCheck(workshop.id, searchName, teacherJid!);
        break;

      case 'groups':
        const groups = await this.whatsapp.getGroups();
        if (groups.length === 0) {
          await this.whatsapp.sendMessage(msg.chatJid, '👥 No active groups found where the bot is participating.');
        } else {
          const groupLines = groups.map((g, idx) => `${idx + 1}. *${g.subject}* (JID: \`${g.id}\`)`).join('\n');
          await this.whatsapp.sendMessage(msg.chatJid, `👥 *Available WhatsApp Groups (${groups.length}):*\n\n${groupLines}`);
        }
        break;

      default:
        break;
    }
  }

  /**
   * Helper to dynamically enroll a group participant in the database workshop
   */
  private async enrollParticipantInDb(workshopId: string, participantJid: string): Promise<void> {
    const cleanPhone = participantJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const dummyId = parseInt(cleanPhone.slice(-9), 10) || Math.floor(Math.random() * 100000000);
    try {
      // Check if student already exists in DB
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

      // Check if already enrolled in this workshop
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
   * Helper to download, parse, and process CSV rosters sent by a teacher
   */
  private async handleCsvImport(msg: IncomingMessage, teacher: any): Promise<void> {
    if (!msg.document) return;

    try {
      await this.whatsapp.sendMessage(msg.chatJid, `⏳ Processing CSV file "${msg.document.fileName}"...`);

      // 1. Download file content
      const buffer = await this.whatsapp.downloadDocument(msg.document);
      const csvText = buffer.toString('utf-8');

      // 2. Parse CSV
      const rows = parseCsvString(csvText);
      if (rows.length === 0) {
        await this.whatsapp.sendMessage(msg.chatJid, '❌ CSV file is empty or headers are not recognized.');
        return;
      }

      // 3. Get participating WhatsApp groups
      const waGroups = await this.whatsapp.getGroups();

      // Track summary statistics
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

          // Find matching group (case-insensitive)
          const matchingGroup = waGroups.find(
            g => g.subject.toLowerCase() === targetGroupName.toLowerCase()
          );

          if (!matchingGroup) {
            summary[targetGroupName].failed.push(`${row.name} (Group not found)`);
            continue;
          }

          const cleanPhone = row.phone.replace(/\D/g, '');
          const studentJid = `${cleanPhone}@s.whatsapp.net`;

          try {
            // Add to WhatsApp group
            await this.whatsapp.addParticipants(matchingGroup.id, [studentJid]);

            // Find or link DB workshop
            let dbWorkshop = await this.db.workshop.findFirst({
              where: { whatsappJid: matchingGroup.id },
            });

            if (!dbWorkshop) {
              // Fallback: search by subject name in DB
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
              // Register/enroll student in database
              const dummyId = parseInt(cleanPhone.slice(-9), 10) || Math.floor(Math.random() * 100000000);
              
              const student = await this.db.student.upsert({
                where: { phoneNumber: studentJid },
                create: {
                  name: row.name,
                  phoneNumber: studentJid,
                  learndashId: dummyId,
                },
                update: {
                  name: row.name, // Keep nickname updated
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
            }

            summary[targetGroupName].added.push(row.name);
          } catch (err: any) {
            summary[targetGroupName].failed.push(`${row.name} (${err.message})`);
          }
        }
      }

      // Compile report
      let report = `📋 *CSV Participant Import Summary*\n\n`;
      let totalAdded = 0;
      let totalFailed = 0;

      for (const [groupName, stats] of Object.entries(summary)) {
        report += `👥 *Group: ${groupName}*\n`;
        if (stats.added.length > 0) {
          report += `✅ Added:\n` + stats.added.map(n => `- ${n}`).join('\n') + '\n';
          totalAdded += stats.added.length;
        }
        if (stats.failed.length > 0) {
          report += `❌ Failed:\n` + stats.failed.map(f => `- ${f}`).join('\n') + '\n';
          totalFailed += stats.failed.length;
        }
        report += `\n`;
      }

      report += `🏁 *Total Processed:* ${totalAdded + totalFailed} | *Added:* ${totalAdded} | *Failed:* ${totalFailed}`;
      await this.whatsapp.sendMessage(msg.chatJid, report);

    } catch (err: any) {
      await logAudit('ERROR', 'CSV_IMPORT_FAIL', `CSV processing failed: ${err.message}`, teacher.phoneNumber);
      await this.whatsapp.sendMessage(msg.chatJid, `❌ Failed to process CSV: ${err.message}`);
    }
  }

  /**
   * Registers a new homework for the workshop and alerts students
   */
  private async handleTeacherHomework(
    workshopId: string,
    lessonId: number | null,
    dueDate: Date,
    chatJid: string,
    query?: string
  ): Promise<void> {
    if (!lessonId) {
      if (!query || query.trim() === '') {
        await this.whatsapp.sendMessage(chatJid, '❌ Please specify a valid Lesson ID or search keyword. Format: `/homework <lesson_id | query>`');
        return;
      }

      // Read cache file
      let cache: any[] = [];
      try {
        if (fs.existsSync('data/learndash_cache.json')) {
          const cacheContent = fs.readFileSync('data/learndash_cache.json', 'utf-8');
          const cacheObj = JSON.parse(cacheContent);
          if (Array.isArray(cacheObj)) {
            cache = cacheObj;
          } else if (cacheObj && Array.isArray(cacheObj.courses)) {
            cache = cacheObj.courses;
          }
        }
      } catch (err) {
        // Ignore cache read issues
      }

      const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
      const matches: { courseName: string; lessonId: number; lessonName: string }[] = [];

      for (const course of cache) {
        if (Array.isArray(course.lessons)) {
          for (const lesson of course.lessons) {
            const matchesAll = terms.every(term =>
              course.courseName.toLowerCase().includes(term) ||
              lesson.lessonName.toLowerCase().includes(term)
            );
            if (matchesAll) {
              matches.push({
                courseName: course.courseName,
                lessonId: lesson.lessonId,
                lessonName: lesson.lessonName
              });
            }
          }
        }
      }

      if (matches.length === 0) {
        await this.whatsapp.sendMessage(chatJid, `❌ No lessons found matching "${query}".`);
        return;
      }

      if (matches.length > 1) {
        let msgText = `🔍 Multiple matching lessons found for "${query}". Please specify the Lesson ID:\n\n`;
        const displayLimit = 10;
        const displayMatches = matches.slice(0, displayLimit);
        for (const match of displayMatches) {
          msgText += `- *${match.courseName}* - ${match.lessonName} (ID: ${match.lessonId})\n`;
        }
        if (matches.length > displayLimit) {
          msgText += `\n...and ${matches.length - displayLimit} more matches. Please refine your query.`;
        }
        await this.whatsapp.sendMessage(chatJid, msgText);
        return;
      }

      // Exactly 1 match found
      const match = matches[0];
      lessonId = match.lessonId;
      await this.whatsapp.sendMessage(chatJid, `🔍 Found 1 matching lesson: *${match.courseName} - ${match.lessonName}* (ID: ${match.lessonId}). Auto-assigning...`);
    }

    // Check if the lesson ID is in our local cache file, warning the user if not
    let cacheValid = false;
    let title = `Lesson ${lessonId} Homework`;

    try {
      if (fs.existsSync('data/learndash_cache.json')) {
        const cacheContent = fs.readFileSync('data/learndash_cache.json', 'utf-8');
        const cacheObj = JSON.parse(cacheContent);
        const cache = Array.isArray(cacheObj) ? cacheObj : (cacheObj.courses || []);
        
        for (const course of cache) {
          if (Array.isArray(course.lessons)) {
            const lesson = course.lessons.find((l: any) => l.lessonId === lessonId);
            if (lesson) {
              cacheValid = true;
              title = lesson.lessonName;
              break;
            }
          }
        }
      }
    } catch (err) {
      // Ignore cache check errors
    }

    if (!cacheValid) {
      await this.whatsapp.sendMessage(
        chatJid,
        `⚠️ *Warning*: Lesson ID *${lessonId}* was not found in the WordPress cache. It has still been assigned, but progress tracking might not sync until the WordPress cache is updated.`
      );
    }

    // Upsert the homework - check if already exists
    let homework = await this.db.homework.findFirst({
      where: {
        workshopId,
        lessonId
      }
    });

    if (homework) {
      await this.db.homework.update({
        where: { id: homework.id },
        data: { dueDate }
      });

      await logAudit('INFO', 'UPDATE_HOMEWORK_DUE', `Teacher updated due date for Lesson ID ${lessonId} to: ${dueDate.toDateString()}`);
      await this.whatsapp.sendMessage(
        chatJid,
        `ℹ️ Homework for *${homework.title}* was already assigned to this class. Due date has been updated to: *${dueDate.toDateString()}*.`
      );
      return;
    }
    homework = await this.db.homework.create({
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
      `📅 *Due Date*: ${dueDate.toDateString()}\n\n` +
      `*Bot assistant is now tracking student progress on LearnDash.*`
    );
  }

  /**
   * Students query pending homework
   */
  private async handleStudentHomeworkList(
    workshopId: string,
    studentJid: string,
    replyJid: string
  ): Promise<void> {
    const student = await this.db.student.findUnique({
      where: { phoneNumber: studentJid },
    });

    if (!student) {
      await this.whatsapp.sendMessage(replyJid, '❌ You are not registered as a student in the database.');
      return;
    }

    const progressLogs = await this.db.progressLog.findMany({
      where: {
        studentId: student.id,
        homework: { workshopId },
        status: { not: 'COMPLETED' },
      },
      include: { homework: true },
      orderBy: { homework: { dueDate: 'asc' } },
    });

    if (progressLogs.length === 0) {
      await this.whatsapp.sendMessage(replyJid, '🎉 You have no pending homework tasks!');
      return;
    }

    const listText = progressLogs
      .map(p => `- *${p.homework.title}* (Due: ${p.homework.dueDate.toDateString()})`)
      .join('\n');

    await this.whatsapp.sendMessage(replyJid, `📖 *Your Pending Homework Tasks:*\n\n${listText}`);
  }

  /**
   * Students mark their oldest pending homework as completed
   */
  private async handleStudentHomeworkDone(
    workshopId: string,
    studentJid: string,
    replyJid: string
  ): Promise<void> {
    const student = await this.db.student.findUnique({
      where: { phoneNumber: studentJid },
    });

    if (!student) {
      await this.whatsapp.sendMessage(replyJid, '❌ You are not registered as a student in the database.');
      return;
    }

    const oldestPending = await this.db.progressLog.findFirst({
      where: {
        studentId: student.id,
        homework: { workshopId },
        status: { not: 'COMPLETED' },
      },
      include: { homework: true },
      orderBy: { homework: { dueDate: 'asc' } },
    });

    if (!oldestPending) {
      await this.whatsapp.sendMessage(replyJid, '🎉 You have no pending homework tasks to mark as done!');
      return;
    }

    const updatedLog = await this.db.progressLog.update({
      where: { id: oldestPending.id },
      data: {
        status: 'COMPLETED',
        submittedAt: new Date(),
      },
      include: { homework: true },
    });

    await logAudit(
      'INFO',
      'STUDENT_MARK_HOMEWORK_DONE',
      `Student ${student.name} (${student.phoneNumber}) marked homework "${updatedLog.homework.title}" as COMPLETED`,
      studentJid
    );

    await this.whatsapp.sendMessage(
      replyJid,
      `✅ Marked homework *${updatedLog.homework.title}* as completed! Great job!`
    );
  }

  private async handleTeacherReportAdvanced(
    args: string[],
    senderJid: string,
    chatJid: string,
    currentWorkshop: any
  ): Promise<void> {
    // Identify if a phone number is specified in args
    const phoneArgIndex = args.findIndex(arg => /^\d{8,15}$/.test(arg.replace(/[@s\.whatsapp\.net]/g, '')));
    let phone: string | null = null;
    let groupArgs = args;

    if (phoneArgIndex !== -1) {
      phone = args[phoneArgIndex];
      if (!phone.includes('@')) {
        phone = `${phone}@s.whatsapp.net`;
      }
      groupArgs = args.filter((_, idx) => idx !== phoneArgIndex);
    }

    const groupName = groupArgs.join(' ').trim();
    const targetDmJid = senderJid;

    // Case A: Both phone and group name specified
    if (phone && groupName) {
      const workshop = await this.db.workshop.findFirst({
        where: { subject: { contains: groupName, mode: 'insensitive' } }
      });
      if (!workshop) {
        await this.whatsapp.sendMessage(chatJid, `❌ Workshop with subject "${groupName}" not found.`);
        return;
      }
      const student = await this.db.student.findUnique({
        where: { phoneNumber: phone },
        include: {
          progress: {
            where: { homework: { workshopId: workshop.id } },
            include: { homework: true }
          }
        }
      });
      if (!student) {
        await this.whatsapp.sendMessage(chatJid, `❌ Student with phone number "${phone.split('@')[0]}" not found.`);
        return;
      }

      let details = '';
      for (const p of student.progress) {
        let statusIcon = '🔴';
        if (p.status === ProgressStatus.COMPLETED) statusIcon = '🟢';
        if (p.status === ProgressStatus.IN_PROGRESS) statusIcon = '🟡';
        if (p.status === ProgressStatus.SKIPPED_EXERCISES) statusIcon = '🟠';
        details += `- *${p.homework.title}*: ${statusIcon} ${p.status.replace('_', ' ')}\n`;
      }

      const reportText = `👤 *Student Progress Report: ${student.name}* 👤\n` +
        `🏫 Class: *${workshop.subject}*\n` +
        `📞 Phone: ${student.phoneNumber.split('@')[0]}\n` +
        `🆔 LearnDash ID: ${student.learndashId}\n\n` +
        `*Homework Progress:*\n${details || 'No homework assigned yet.'}`;

      await this.whatsapp.sendMessage(targetDmJid, reportText);
      await this.whatsapp.sendMessage(chatJid, `📩 I have sent the progress report for student *${student.name}* in *${workshop.subject}* to your private DM.`);
      await logAudit('INFO', 'SEND_MANUAL_REPORT', `Sent student report for ${student.name} in workshop ${workshop.subject} to teacher.`, targetDmJid);
      return;
    }

    // Case B: Only phone specified
    if (phone && !groupName) {
      const student = await this.db.student.findUnique({
        where: { phoneNumber: phone },
        include: {
          progress: {
            include: {
              homework: {
                include: { workshop: true }
              }
            }
          }
        }
      });
      if (!student) {
        await this.whatsapp.sendMessage(chatJid, `❌ Student with phone number "${phone.split('@')[0]}" not found.`);
        return;
      }

      let details = '';
      for (const p of student.progress) {
        let statusIcon = '🔴';
        if (p.status === ProgressStatus.COMPLETED) statusIcon = '🟢';
        if (p.status === ProgressStatus.IN_PROGRESS) statusIcon = '🟡';
        if (p.status === ProgressStatus.SKIPPED_EXERCISES) statusIcon = '🟠';
        details += `- *${p.homework.title}* (${p.homework.workshop.subject}): ${statusIcon} ${p.status.replace('_', ' ')}\n`;
      }

      const reportText = `👤 *Student Progress Report: ${student.name}* 👤\n` +
        `📞 Phone: ${student.phoneNumber.split('@')[0]}\n` +
        `🆔 LearnDash ID: ${student.learndashId}\n\n` +
        `*Homework Progress:*\n${details || 'No homework assigned yet.'}`;

      await this.whatsapp.sendMessage(targetDmJid, reportText);
      await this.whatsapp.sendMessage(chatJid, `📩 I have sent the progress report for student *${student.name}* to your private DM.`);
      await logAudit('INFO', 'SEND_MANUAL_REPORT', `Sent student report for ${student.name} to teacher.`, targetDmJid);
      return;
    }

    // Case C: Only group name specified
    if (!phone && groupName) {
      const workshop = await this.db.workshop.findFirst({
        where: { subject: { contains: groupName, mode: 'insensitive' } }
      });
      if (!workshop) {
        await this.whatsapp.sendMessage(chatJid, `❌ Workshop with subject "${groupName}" not found.`);
        return;
      }

      const reportText = await this.compileProgressReport(workshop.id);
      await this.whatsapp.sendMessage(targetDmJid, reportText);
      await this.whatsapp.sendMessage(chatJid, `📩 I have sent the progress report for workshop *${workshop.subject}* to your private DM.`);
      await logAudit('INFO', 'SEND_MANUAL_REPORT', `Sent group report for workshop ${workshop.subject} to teacher.`, targetDmJid);
      return;
    }

    // Case D: Neither phone nor group name specified
    if (!phone && !groupName) {
      if (!currentWorkshop) {
        await this.whatsapp.sendMessage(
          chatJid,
          '❌ In a private chat, please specify the class subject or student phone number. Usage: `/report [<group_name>] [<phone_number>]`'
        );
        return;
      }

      const reportText = await this.compileProgressReport(currentWorkshop.id);
      await this.whatsapp.sendMessage(targetDmJid, reportText);
      await this.whatsapp.sendMessage(chatJid, `📩 I have sent the progress report for workshop *${currentWorkshop.subject}* to your private DM.`);
      await logAudit('INFO', 'SEND_MANUAL_REPORT', `Sent group report for workshop ${currentWorkshop.subject} to teacher.`, targetDmJid);
      return;
    }
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
  public async compileProgressReport(workshopId: string): Promise<string> {
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

  /**
   * Displays role-based command guide
   */
  private async handleHelp(role: string, replyJid: string): Promise<void> {
    const isTeacher = role === 'teacher';
    const title = isTeacher 
      ? `📋 *Revision Workshop Bot - Teacher Command Guide* 📋`
      : `📖 *Revision Workshop Bot - Student Command Guide* 📖`;

    const lines: string[] = [title, ''];

    for (const cmdKey of Object.keys(COMMANDS)) {
      const cmd = COMMANDS[cmdKey];
      if (!cmd.roles.includes(role as any)) {
        continue;
      }

      const argsPart = cmd.argsUsage ? ` ${cmd.argsUsage}` : '';
      lines.push(`- \`/${cmd.name}${argsPart}\` : ${cmd.description}`);
      if (cmd.exampleUsage) {
        const examples = cmd.exampleUsage.split('\n');
        for (const ex of examples) {
          lines.push(`  _Example:_ \`${ex}\``);
        }
      }
      lines.push('');
    }

    await this.whatsapp.sendMessage(replyJid, lines.join('\n').trim());
  }

  private parsePhoneJid(rawPhone: string): string {
    let clean = rawPhone.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
    if (clean.startsWith('0')) {
      clean = '60' + clean.substring(1);
    }
    if (clean.length > 13) {
      return `${clean}@lid`;
    }
    return `${clean}@s.whatsapp.net`;
  }

  /**
   * Registers student or teacher and dispatches onboarding DM
   */
  private async handleTeacherInvite(msg: IncomingMessage, replyJid: string): Promise<void> {
    const textParts = msg.text.trim().split(/\s+/);
    const inviteType = (textParts[1] || '').toLowerCase();
    const rawPhone = textParts[2] || '';
    const name = textParts.slice(3).join(' ').trim();

    if (!inviteType || !rawPhone || !name) {
      await this.whatsapp.sendMessage(replyJid, '❌ Invalid format. Use: `/invite student|teacher <phone> <name>`');
      return;
    }

    if (inviteType !== 'student' && inviteType !== 'teacher') {
      await this.whatsapp.sendMessage(replyJid, '❌ Invalid type. Specify either `student` or `teacher`.');
      return;
    }

    const targetJid = this.parsePhoneJid(rawPhone);

    try {
      if (inviteType === 'teacher') {
        const oppositeStudent = await this.db.student.findUnique({
          where: { phoneNumber: targetJid }
        });
        if (oppositeStudent) {
          await this.whatsapp.sendMessage(
            replyJid,
            `❌ Error: The phone number ${rawPhone} is already registered as a Student (*${oppositeStudent.name}*) in the database. A number cannot be both a student and a teacher.`
          );
          return;
        }

        await this.db.teacher.upsert({
          where: { phoneNumber: targetJid },
          create: { name, phoneNumber: targetJid },
          update: { name }
        });

        await logAudit('INFO', 'TEACHER_INVITED', `Teacher ${name} invited: ${targetJid}`, msg.senderJid);
        await this.whatsapp.sendMessage(replyJid, `✅ Teacher *${name}* successfully registered in the database.`);
        
        // Send welcome message to the invited teacher
        await this.whatsapp.sendMessage(
          targetJid,
          `👋 Hello Teacher *${name}*!\n` +
          `You have been registered as an authorized teacher in the Revision Workshop Class Assistant Bot.\n` +
          `Type \`/help\` to see the list of available commands.`
        );
      } else {
        const oppositeTeacher = await this.db.teacher.findUnique({
          where: { phoneNumber: targetJid }
        });
        if (oppositeTeacher) {
          await this.whatsapp.sendMessage(
            replyJid,
            `❌ Error: The phone number ${rawPhone} is already registered as a Teacher (*${oppositeTeacher.name}*) in the database. A number cannot be both a student and a teacher.`
          );
          return;
        }

        // Check if student already exists by JID
        let student = await this.db.student.findUnique({
          where: { phoneNumber: targetJid }
        });

        const placeholderId = -Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 10000);

        if (!student) {
          student = await this.db.student.create({
            data: {
              name,
              phoneNumber: targetJid,
              learndashId: placeholderId
            }
          });
        } else {
          // If student exists but has a placeholder ID, regenerate it or keep it negative
          if (student.learndashId >= 0) {
            await this.whatsapp.sendMessage(replyJid, `⚠️ Student *${name}* is already registered and linked (ID: ${student.learndashId}).`);
            return;
          }
        }

        await logAudit('INFO', 'STUDENT_INVITED', `Student ${name} invited: ${targetJid}`, msg.senderJid);
        await this.whatsapp.sendMessage(replyJid, `✅ Student *${name}* invited. Onboarding DM sent.`);

        // Send onboarding message to student with user ID guide
        const welcomeMessage = 
          `👋 Hello *${name}*!\n` +
          `You have been invited to Revision Workshops class tracking.\n\n` +
          `Please reply directly to this message with your *WordPress/LearnDash User ID* (numbers only) to link your account.\n\n` +
          `👉 Reply with: your ID number (e.g. *12345*)\n` +
          `❌ Reply with: *N/A* to cancel this update.\n\n` +
          `ℹ️ *How to find your LearnDash User ID*:\n` +
          `1. Log in to your account at *course.revision.my*\n` +
          `2. Tap on "Profile" (under the menu or avatar).\n` +
          `3. Your User ID is displayed under your profile avatar/name, or visible in your browser profile URL.`;
        
        await this.whatsapp.sendMessage(targetJid, welcomeMessage);
      }
    } catch (err: any) {
      await logAudit('ERROR', 'INVITE_COMMAND_FAILED', `Failed to invite: ${err.message}`, msg.senderJid);
      await this.whatsapp.sendMessage(replyJid, `❌ Failed to execute invite command: ${err.message}`);
    }
  }

  /**
   * Enrolls a student in a workshop class via chat command
   */
  private async handleTeacherAddStudent(msg: IncomingMessage, replyJid: string): Promise<void> {
    const textParts = msg.text.trim().split(/\s+/);
    const rawPhone = textParts[1] || '';
    const subject = textParts.slice(2).join(' ').trim();

    if (!rawPhone || !subject) {
      await this.whatsapp.sendMessage(replyJid, '❌ Invalid format. Use: `/add <phone> <class_subject>`');
      return;
    }

    const targetJid = this.parsePhoneJid(rawPhone);

    // Find student in DB. If not, auto-create student with a negative unique placeholder
    let student = await this.db.student.findUnique({
      where: { phoneNumber: targetJid }
    });

    if (!student) {
      const placeholderId = -Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 10000);
      student = await this.db.student.create({
        data: {
          name: `Student-${rawPhone.replace(/\D/g, '')}`,
          phoneNumber: targetJid,
          learndashId: placeholderId
        }
      });
    }

    // Resolve workshop by subject matching (contains / case-insensitive)
    const workshopMatch = await this.db.workshop.findFirst({
      where: {
        subject: {
          contains: subject,
          mode: 'insensitive'
        }
      }
    });

    if (!workshopMatch) {
      const allWorkshops = await this.db.workshop.findMany({
        select: { subject: true }
      });
      const listStr = allWorkshops.map(w => `- ${w.subject}`).join('\n');
      await this.whatsapp.sendMessage(
        replyJid,
        `❌ Workshop class matching "${subject}" not found in database.\n\n` +
        `📋 *Available class workshops*:\n${listStr || 'None configured yet.'}`
      );
      return;
    }

    try {
      // Check if student is already enrolled
      const existingEnrollment = await this.db.studentWorkshop.findUnique({
        where: {
          studentId_workshopId: {
            studentId: student.id,
            workshopId: workshopMatch.id
          }
        }
      });

      if (existingEnrollment) {
        await this.whatsapp.sendMessage(
          replyJid,
          `ℹ️ Student *${student.name}* is already enrolled in *${workshopMatch.subject}*.`
        );
        return;
      }

      // Enroll in DB
      await this.db.studentWorkshop.create({
        data: {
          studentId: student.id,
          workshopId: workshopMatch.id
        }
      });

      await logAudit('INFO', 'STUDENT_ENROLLED_VIA_CHAT', `Student ${student.phoneNumber} enrolled in "${workshopMatch.subject}"`, msg.senderJid);
      
      let addStatus = 'added';
      if (workshopMatch.whatsappJid) {
        try {
          await this.whatsapp.addParticipants(workshopMatch.whatsappJid, [targetJid]);
          await this.whatsapp.sendMessage(
            workshopMatch.whatsappJid,
            `👋 Welcome *${student.name}* to our *${workshopMatch.subject}* WhatsApp group class!`
          );
        } catch (addErr: any) {
          // Direct add failed (privacy settings). Fall back to invite link.
          try {
            const code = await this.whatsapp.getGroupInviteCode(workshopMatch.whatsappJid);
            const inviteUrl = `https://chat.whatsapp.com/${code}`;
            
            await this.whatsapp.sendMessage(
              targetJid,
              `👋 Hello *${student.name}*!\n` +
              `You have been enrolled in *${workshopMatch.subject}* class.\n` +
              `Please tap this link to join the class WhatsApp group:\n` +
              `🔗 ${inviteUrl}`
            );
            addStatus = 'invite link sent';
          } catch (inviteErr: any) {
            addStatus = `invite failed (${inviteErr.message})`;
          }
        }
      }

      if (addStatus === 'added') {
        await this.whatsapp.sendMessage(replyJid, `✅ Success: Enrolled *${student.name}* in *${workshopMatch.subject}* and added to WhatsApp group.`);
      } else if (addStatus === 'invite link sent') {
        await this.whatsapp.sendMessage(replyJid, `⚠️ Enrolled *${student.name}* in *${workshopMatch.subject}*. Direct add blocked by privacy; group invite link DM-ed to student instead.`);
      } else {
        await this.whatsapp.sendMessage(replyJid, `⚠️ Enrolled *${student.name}* in *${workshopMatch.subject}*, but failed group sync: ${addStatus}`);
      }

    } catch (err: any) {
      await this.whatsapp.sendMessage(replyJid, `❌ Failed to enroll student: ${err.message}`);
    }
  }

  /**
   * Corrects student name or LearnDash ID in the database
   */
  private async handleTeacherProfileUpdate(msg: IncomingMessage, replyJid: string): Promise<void> {
    const textParts = msg.text.trim().split(/\s+/);
    const rawPhone = textParts[1] || '';
    const field = (textParts[2] || '').toLowerCase();
    const value = textParts.slice(3).join(' ').trim();

    if (!rawPhone || !field || !value) {
      await this.whatsapp.sendMessage(replyJid, '❌ Invalid format. Use: `/profile <phone> name|id <new_value>`');
      return;
    }

    if (field !== 'name' && field !== 'id') {
      await this.whatsapp.sendMessage(replyJid, '❌ Invalid field. Only `name` or `id` can be updated.');
      return;
    }

    const targetJid = this.parsePhoneJid(rawPhone);

    // Find student in DB
    let student = await this.db.student.findUnique({
      where: { phoneNumber: targetJid }
    });

    if (!student) {
      await this.whatsapp.sendMessage(
        replyJid,
        `❌ Student with phone/JID "${rawPhone}" not found in database.\n\n` +
        `👉 *Suggestion*: To register this student, use: \`/invite student ${rawPhone} <name>\``
      );
      return;
    }

    try {
      if (field === 'name') {
        await this.db.student.update({
          where: { id: student.id },
          data: { name: value }
        });
        await logAudit('INFO', 'TEACHER_UPDATE_STUDENT_NAME', `Teacher updated student ${student.phoneNumber} name to "${value}"`, msg.senderJid);
        await this.whatsapp.sendMessage(replyJid, `✅ Successfully updated student name to *${value}*.`);
      } else {
        // field === 'id'
        const userId = parseInt(value, 10);
        if (isNaN(userId) || userId <= 0) {
          await this.whatsapp.sendMessage(replyJid, '❌ LearnDash ID must be a positive integer.');
          return;
        }

        // Check if already in use
        const existing = await this.db.student.findUnique({
          where: { learndashId: userId }
        });
        if (existing && existing.id !== student.id) {
          await this.whatsapp.sendMessage(
            replyJid,
            `❌ Error: LearnDash ID ${userId} is already linked to student *${existing.name}*.\n\n` +
            `👉 *Suggestion*: If you want to move this ID, update the other student's profile to another ID or "N/A" first.`
          );
          return;
        }

        await this.whatsapp.sendMessage(replyJid, `⏳ Verifying LearnDash ID ${userId} against WordPress...`);
        const verifyRes = await this.learndash.verifyUserId(userId);
        if (!verifyRes.exists) {
          if (verifyRes.error) {
            await this.whatsapp.sendMessage(replyJid, `⚠️ Verification connection error: ${verifyRes.error}. ID update bypassed and saved anyway.`);
          } else {
            await this.whatsapp.sendMessage(replyJid, `❌ Verification failed: LearnDash account ID ${userId} was not found on WordPress.`);
            return;
          }
        }

        await this.db.student.update({
          where: { id: student.id },
          data: { learndashId: userId }
        });
        
        await logAudit('INFO', 'TEACHER_UPDATE_STUDENT_LD_ID', `Teacher updated student ${student.phoneNumber} ID to ${userId}`, msg.senderJid);
        await this.whatsapp.sendMessage(replyJid, `✅ Successfully updated student *${student.name}* LearnDash ID to *${userId}*.`);
      }
    } catch (err: any) {
      await this.whatsapp.sendMessage(replyJid, `❌ Failed to update profile: ${err.message}`);
    }
  }

  /**
   * Deletes a homework assignment and cascades progress logs
   */
  private async handleTeacherHomeworkDelete(
    workshopId: string,
    lessonId: number | null,
    chatJid: string
  ): Promise<void> {
    if (!lessonId) {
      await this.whatsapp.sendMessage(chatJid, '❌ Please specify a valid Lesson ID to delete. Format: `/homework delete <lesson_id>`');
      return;
    }

    const homework = await this.db.homework.findFirst({
      where: {
        workshopId,
        lessonId
      }
    });

    if (!homework) {
      await this.whatsapp.sendMessage(chatJid, `❌ No homework found for Lesson ID ${lessonId} in this class.`);
      return;
    }

    await this.db.homework.delete({
      where: { id: homework.id }
    });

    await logAudit('INFO', 'DELETE_HOMEWORK', `Teacher deleted homework for Lesson ID ${lessonId} in workshop ${workshopId}`);
    await this.whatsapp.sendMessage(chatJid, `✅ Successfully deleted homework assignment for *${homework.title}*.`);
  }

  /**
   * Directly links a student's own LearnDash ID via command
   */
  private async handleDirectStudentLink(
    studentJid: string,
    userId: number,
    chatJid: string
  ): Promise<void> {
    const student = await this.db.student.findUnique({
      where: { phoneNumber: studentJid }
    });

    if (!student) {
      await this.whatsapp.sendMessage(chatJid, '❌ You are not registered as a student in the database. Please ask your teacher to invite you.');
      return;
    }

    // Check if ID already in use
    const existing = await this.db.student.findUnique({
      where: { learndashId: userId }
    });

    if (existing && existing.id !== student.id) {
      await this.whatsapp.sendMessage(
        chatJid,
        `❌ Error: LearnDash ID ${userId} is already linked to student *${existing.name}*. Please double-check your ID or contact your teacher.`
      );
      return;
    }

    await this.whatsapp.sendMessage(chatJid, '⏳ Verifying your User ID against WordPress LearnDash...');
    
    const verifyRes = await this.learndash.verifyUserId(userId);
    if (verifyRes.exists) {
      await this.db.student.update({
        where: { id: student.id },
        data: { learndashId: userId }
      });
      await logAudit('INFO', 'STUDENT_DIRECT_LINK_SUCCESS', `Student ${student.phoneNumber} linked LearnDash ID: ${userId}`, studentJid);
      await this.whatsapp.sendMessage(chatJid, `✅ Success! Your profile is linked to LearnDash ID: *${userId}*.`);
    } else {
      if (verifyRes.error) {
        await this.whatsapp.sendMessage(chatJid, `⚠️ Verification connection error. We could not verify your ID with the LearnDash server. Please try again later.`);
      } else {
        await this.whatsapp.sendMessage(
          chatJid,
          `❌ Error: WordPress/LearnDash account ID *${userId}* was not found. Please double-check your ID.`
        );
      }
    }
  }

  /**
   * Allows teacher to unlink a student's LearnDash ID by phone
   */
  private async handleTeacherUnlink(rawPhone: string, replyJid: string): Promise<void> {
    const targetJid = this.parsePhoneJid(rawPhone);
    const student = await this.db.student.findUnique({
      where: { phoneNumber: targetJid }
    });

    if (!student) {
      await this.whatsapp.sendMessage(replyJid, `❌ Student with phone "${rawPhone}" not found in database.`);
      return;
    }

    const placeholderId = -Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 10000);
    await this.db.student.update({
      where: { id: student.id },
      data: { learndashId: placeholderId }
    });

    await logAudit('INFO', 'TEACHER_UNLINK_STUDENT', `Teacher unlinked LearnDash ID for student ${student.phoneNumber}`, targetJid);
    await this.whatsapp.sendMessage(replyJid, `✅ Successfully unlinked LearnDash ID for student *${student.name}*.`);
  }

  /**
   * Allows student to unlink their own LearnDash ID
   */
  private async handleStudentUnlink(studentJid: string, replyJid: string): Promise<void> {
    const student = await this.db.student.findUnique({
      where: { phoneNumber: studentJid }
    });

    if (!student) {
      await this.whatsapp.sendMessage(replyJid, '❌ You are not registered as a student in the database.');
      return;
    }

    const placeholderId = -Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 10000);
    await this.db.student.update({
      where: { id: student.id },
      data: { learndashId: placeholderId }
    });

    await logAudit('INFO', 'STUDENT_UNLINK_SELF', `Student ${student.phoneNumber} unlinked their own LearnDash ID`, studentJid);
    await this.whatsapp.sendMessage(replyJid, '✅ Successfully unlinked your LearnDash ID from this phone number.');
  }

  /**
   * Handles deletion of student/teacher records globally, or unenrollment from specific workshop subjects
   */
  private async handleTeacherRemove(msg: IncomingMessage, replyJid: string): Promise<void> {
    const textParts = msg.text.trim().split(/\s+/);
    const type = (textParts[1] || '').toLowerCase();
    const rawPhone = textParts[2] || '';
    const subject = textParts.slice(3).join(' ').trim();

    if (!type || !rawPhone) {
      await this.whatsapp.sendMessage(replyJid, '❌ Invalid format. Use: `/remove student|teacher <phone> [<subject>]`');
      return;
    }

    const targetJid = this.parsePhoneJid(rawPhone);

    try {
      if (type === 'teacher') {
        const teacher = await this.db.teacher.findUnique({
          where: { phoneNumber: targetJid },
          include: { workshops: true }
        });

        if (!teacher) {
          await this.whatsapp.sendMessage(replyJid, `❌ Teacher with phone "${rawPhone}" not found in database.`);
          return;
        }

        if (teacher.workshops.length > 0) {
          const subjects = teacher.workshops.map(w => w.subject).join(', ');
          await this.whatsapp.sendMessage(
            replyJid,
            `❌ Cannot remove teacher *${teacher.name}* because they are assigned to active workshops: *${subjects}*.\n` +
            `Please delete or reassign those workshops first.`
          );
          return;
        }

        await this.db.teacher.delete({
          where: { id: teacher.id }
        });

        await logAudit('INFO', 'TEACHER_REMOVED', `Teacher ${teacher.name} (${targetJid}) deleted globally`, msg.senderJid);
        await this.whatsapp.sendMessage(replyJid, `✅ Teacher *${teacher.name}* successfully removed from the database.`);
      } else {
        const student = await this.db.student.findUnique({
          where: { phoneNumber: targetJid },
          include: { enrollments: { include: { workshop: true } } }
        });

        if (!student) {
          await this.whatsapp.sendMessage(replyJid, `❌ Student with phone "${rawPhone}" not found in database.`);
          return;
        }

        if (subject) {
          const enrollment = student.enrollments.find(
            e => e.workshop.subject.toLowerCase().includes(subject.toLowerCase())
          );

          if (!enrollment) {
            const enrolledClasses = student.enrollments.map(e => e.workshop.subject).join(', ');
            await this.whatsapp.sendMessage(
              replyJid,
              `❌ Student *${student.name}* is not enrolled in a workshop matching "${subject}".\n` +
              `Active enrollments: *${enrolledClasses || 'None'}*`
            );
            return;
          }

          await this.db.studentWorkshop.delete({
            where: {
              studentId_workshopId: {
                studentId: student.id,
                workshopId: enrollment.workshopId
              }
            }
          });

          if (enrollment.workshop.whatsappJid) {
            try {
              await this.whatsapp.removeParticipants(enrollment.workshop.whatsappJid, [targetJid]);
            } catch (err) {
              // Ignore group sync failure
            }
          }

          await logAudit('INFO', 'STUDENT_UNENROLLED', `Student ${student.name} unenrolled from "${enrollment.workshop.subject}"`, msg.senderJid);
          await this.whatsapp.sendMessage(
            replyJid,
            `✅ Student *${student.name}* successfully unenrolled from *${enrollment.workshop.subject}*.`
          );
        } else {
          await this.db.student.delete({
            where: { id: student.id }
          });

          await logAudit('INFO', 'STUDENT_REMOVED', `Student ${student.name} (${targetJid}) deleted globally`, msg.senderJid);
          await this.whatsapp.sendMessage(replyJid, `✅ Student *${student.name}* successfully removed from the database.`);
        }
      }
    } catch (err: any) {
      await logAudit('ERROR', 'REMOVE_COMMAND_FAILED', `Failed to remove: ${err.message}`, msg.senderJid);
      await this.whatsapp.sendMessage(replyJid, `❌ Failed to execute remove command: ${err.message}`);
    }
  }

  private async handleTeacherClassCRUD(args: string[], replyJid: string): Promise<void> {
    const subAction = args[0].toLowerCase();
    const daysList = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    if (subAction === 'list') {
      const workshops = await this.db.workshop.findMany({
        include: { teacher: true }
      });
      if (workshops.length === 0) {
        await this.whatsapp.sendMessage(replyJid, '📋 *No workshops registered yet.*');
        return;
      }
      let listMsg = `📋 *All Registered Classes (${workshops.length}):*\n\n`;
      for (const w of workshops) {
        listMsg += `- *${w.subject}* (ID: ${w.id})\n` +
          `  Course ID: ${w.courseId}\n` +
          `  Teacher: ${w.teacher.name} (${w.teacher.phoneNumber.split('@')[0]})\n` +
          `  Schedule: Every ${daysList[w.classDayOfWeek]} at ${w.classTime}\n` +
          `  Link: ${w.meetingLink || 'None'}\n\n`;
      }
      await this.whatsapp.sendMessage(replyJid, listMsg.trim());
      return;
    }

    if (subAction === 'create') {
      const createParams = parseClassCreationArgs(args.slice(1));
      if (!createParams) {
        await this.whatsapp.sendMessage(
          replyJid,
          '❌ Invalid arguments for `/class create`. Format:\n' +
          '`/class create <subject> <courseId> <day> <time> <teacher_phone> <teacher_name>`\n' +
          'Example: `/class create SPM Physics 101 Monday 20:00 60123456789 John Doe`'
        );
        return;
      }

      // Check if workshop subject already exists to prevent duplicate
      const existing = await this.db.workshop.findFirst({
        where: { subject: createParams.subject }
      });
      if (existing) {
        await this.whatsapp.sendMessage(replyJid, `❌ A workshop with subject "${createParams.subject}" already exists.`);
        return;
      }

      // Upsert teacher
      const teacher = await this.db.teacher.upsert({
        where: { phoneNumber: createParams.teacherPhone },
        create: { name: createParams.teacherName, phoneNumber: createParams.teacherPhone },
        update: { name: createParams.teacherName }
      });

      // Generate default Google Meet link
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      const randSegment = (len: number) => Array.from({ length: len }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
      const defaultLink = `https://meet.google.com/${randSegment(3)}-${randSegment(4)}-${randSegment(3)}`;

      // Create workshop
      const workshop = await this.db.workshop.create({
        data: {
          subject: createParams.subject,
          courseId: createParams.courseId,
          classDayOfWeek: createParams.dayOfWeek,
          classTime: createParams.time,
          teacherId: teacher.id,
          meetingLink: defaultLink
        }
      });

      await logAudit('INFO', 'CREATE_CLASS', `Teacher created class ${workshop.subject} (ID: ${workshop.id})`);

      await this.whatsapp.sendMessage(
        replyJid,
        `✅ *Workshop Successfully Created!*\n\n` +
        `🏫 *Subject*: ${workshop.subject}\n` +
        `🆔 *Course ID*: ${workshop.courseId}\n` +
        `📅 *Schedule*: Every ${daysList[workshop.classDayOfWeek]} at ${workshop.classTime}\n` +
        `👩‍🏫 *Teacher*: ${teacher.name} (${teacher.phoneNumber.split('@')[0]})\n` +
        `📅 *Class Link*: ${workshop.meetingLink}`
      );
      return;
    }

    if (subAction === 'delete' || subAction === 'archive') {
      const query = args.slice(1).join(' ').trim();
      if (!query) {
        await this.whatsapp.sendMessage(replyJid, '❌ Please specify the class subject or ID to delete/archive. Format: `/class delete <subject_or_id>`');
        return;
      }
      const workshop = await this.db.workshop.findFirst({
        where: {
          OR: [
            { id: query },
            { subject: { contains: query, mode: 'insensitive' } }
          ]
        }
      });
      if (!workshop) {
        await this.whatsapp.sendMessage(replyJid, `❌ Class "${query}" not found.`);
        return;
      }
      await this.db.workshop.delete({
        where: { id: workshop.id }
      });
      await logAudit('INFO', 'DELETE_CLASS', `Teacher deleted class ${workshop.subject} (ID: ${workshop.id})`);
      await this.whatsapp.sendMessage(replyJid, `✅ Workshop *${workshop.subject}* (ID: ${workshop.id}) has been successfully deleted.`);
      return;
    }
  }
}

interface ClassCreationParams {
  subject: string;
  courseId: number;
  dayOfWeek: number;
  time: string;
  teacherPhone: string;
  teacherName: string;
}

function parseClassCreationArgs(args: string[]): ClassCreationParams | null {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayAbbrevs = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  let foundIdx = -1;
  for (let i = 0; i < args.length - 4; i++) {
    const isNum = /^\d+$/.test(args[i]);
    if (!isNum) continue;

    const nextArg = args[i + 1].toLowerCase();
    const isDay = days.includes(nextArg) || dayAbbrevs.includes(nextArg) || /^[0-6]$/.test(nextArg);
    if (!isDay) continue;

    const nextNextArg = args[i + 2];
    const isTime = /^\d{1,2}(:\d{2})?(am|pm)?$/i.test(nextNextArg) || /^\d{1,2}:\d{2}$/.test(nextNextArg);
    if (!isTime) continue;

    const nextNextNextArg = args[i + 3].replace(/[@s\.whatsapp\.net]/g, '');
    const isPhone = /^\d{8,15}$/.test(nextNextNextArg);
    if (!isPhone) continue;

    foundIdx = i;
    break;
  }

  if (foundIdx === -1) {
    return null;
  }

  const subject = args.slice(0, foundIdx).join(' ');
  const courseId = parseInt(args[foundIdx], 10);
  const dayStr = args[foundIdx + 1].toLowerCase();
  
  let dayOfWeek = parseInt(dayStr, 10);
  if (isNaN(dayOfWeek)) {
    dayOfWeek = days.indexOf(dayStr);
    if (dayOfWeek === -1) {
      dayOfWeek = dayAbbrevs.indexOf(dayStr);
    }
  }

  const time = args[foundIdx + 2];
  const teacherPhoneRaw = args[foundIdx + 3];
  const teacherPhone = teacherPhoneRaw.includes('@') ? teacherPhoneRaw : `${teacherPhoneRaw}@s.whatsapp.net`;
  const teacherName = args.slice(foundIdx + 4).join(' ');

  if (!subject || isNaN(courseId) || dayOfWeek === -1 || !time || !teacherPhone || !teacherName) {
    return null;
  }

  return {
    subject,
    courseId,
    dayOfWeek,
    time,
    teacherPhone,
    teacherName
  };
}
