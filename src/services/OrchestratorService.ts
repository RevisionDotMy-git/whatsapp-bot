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

    // Intercept CSV upload from Teacher
    if (msg.document) {
      const isCsv = msg.document.mimetype === 'text/csv' || 
                    msg.document.mimetype === 'text/comma-separated-values' || 
                    msg.document.fileName.endsWith('.csv');
      if (isCsv) {
        const teacher = await this.db.teacher.findUnique({
          where: { phoneNumber: msg.senderJid },
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

    // 1. Resolve Workshop based on Group JID or Teacher JID
    let workshop = await this.db.workshop.findFirst({
      where: msg.isGroup ? { whatsappJid: msg.chatJid } : { teacher: { phoneNumber: msg.senderJid } },
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
          where: { student: { phoneNumber: msg.senderJid } },
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
      await logAudit(
        'WARN',
        'WORKSHOP_NOT_FOUND',
        `Could not resolve workshop for sender ${msg.senderJid} or chat ${msg.chatJid}`,
        msg.senderJid
      );
    } else {
      await logAudit(
        'INFO',
        'WORKSHOP_MATCHED',
        `Resolved workshop "${workshop.subject}" (ID: ${workshop.id}) for chat ${msg.chatJid}`,
        msg.senderJid
      );
    }

    // Check for natural language LearnDash homework assignment from Teacher
    if (workshop && msg.text && workshop.teacher.phoneNumber === msg.senderJid) {
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
      const isEnrolled = workshop.students.some(s => s.student.phoneNumber === msg.senderJid);
      const isTeacher = workshop.teacher.phoneNumber === msg.senderJid;
      if (!isEnrolled && !isTeacher) {
        await this.enrollParticipantInDb(workshop.id, msg.senderJid);
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

    if (!workshop) return; // No active workshop matched for this conversation JID JID

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
}
