import { PrismaClient, ProgressStatus } from '@prisma/client';
import { IncomingMessage, IWhatsAppClient } from '../../interfaces/IWhatsAppClient.js';
import { ICommandRouter, CommandExecutionResult } from './ICommandRouter.js';
import { IClassManager } from '../classManager/IClassManager.js';
import { IHomeworkManager } from '../homeworkManager/IHomeworkManager.js';
import { ILearnDashSync } from '../learndashSync/ILearnDashSync.js';
import { INotificationManager } from '../notificationManager/INotificationManager.js';
import { parseCommand } from '../../utils/commandParser.js';
import { COMMANDS } from '../../utils/commandRegistry.js';
import { logAudit } from '../../services/db.js';
import { CONFIG } from '../../config/constants.js';

export class CommandRouter implements ICommandRouter {
  private prisma: PrismaClient;
  private classManager: IClassManager;
  private homeworkManager: IHomeworkManager;
  private learndashSync: ILearnDashSync;
  private notificationManager: INotificationManager;

  constructor(
    prisma: PrismaClient,
    classManager: IClassManager,
    homeworkManager: IHomeworkManager,
    learndashSync: ILearnDashSync,
    notificationManager: INotificationManager,
    private whatsapp: IWhatsAppClient
  ) {
    this.prisma = prisma;
    this.classManager = classManager;
    this.homeworkManager = homeworkManager;
    this.learndashSync = learndashSync;
    this.notificationManager = notificationManager;
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

  async executeCommand(
    msg: IncomingMessage,
    senderRole: 'teacher' | 'student',
    workshopId: string | null
  ): Promise<CommandExecutionResult | null> {
    // 1. Fetch teachers and students phone list dynamically for command parser
    const teachers = await this.prisma.teacher.findMany({ select: { phoneNumber: true } });
    const students = await this.prisma.student.findMany({ select: { phoneNumber: true } });

    const teacherJids = teachers.map((t) => t.phoneNumber);
    const studentJids = students.map((s) => s.phoneNumber);

    const resolvedSenderJid = msg.senderJid;

    // 2. Parse command
    const parsed = parseCommand(
      msg.text,
      resolvedSenderJid,
      teacherJids,
      studentJids,
      !!(msg.rawKey && msg.rawKey.fromMe)
    );
    if (!parsed) {
      return null;
    }

    // 3. Authorization check
    if (!parsed.isAuthorized) {
      return { replyText: '⚠️ Unauthorized command.', shouldDeleteOriginal: false };
    }

    // 4. Argument validation check
    if (!parsed.isValid) {
      return { replyText: `❌ ${parsed.validationError || 'Invalid command usage.'}`, shouldDeleteOriginal: false };
    }

    // Delete teacher command messages in group chats to maintain student UI/UX
    const shouldDeleteOriginal = !!(msg.isGroup && parsed.role === 'teacher');

    // 5. Dispatch command
    switch (parsed.command) {
      case 'help': {
        const title =
          parsed.role === 'teacher'
            ? `📋 *Revision Workshop Bot - Teacher Command Guide* 📋`
            : `📖 *Revision Workshop Bot - Student Command Guide* 📖`;

        const lines: string[] = [title, ''];

        for (const cmdKey of Object.keys(COMMANDS)) {
          const cmd = COMMANDS[cmdKey];
          if (!cmd.roles.includes(parsed.role as any)) {
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

        return { replyText: lines.join('\n').trim(), shouldDeleteOriginal };
      }

      case 'invite': {
        const inviteType = parsed.args[0].toLowerCase() as 'student' | 'teacher';
        const rawPhone = parsed.args[1];
        const name = parsed.args.slice(2).join(' ').trim();

        try {
          const targetJid = this.parsePhoneJid(rawPhone);

          let isPending = false;
          if (inviteType === 'student') {
            const existingStudent = await this.prisma.student.findUnique({
              where: { phoneNumber: targetJid },
            });
            if (existingStudent && existingStudent.learndashId < 0) {
              isPending = true;
            }
          }

          const { inviteMsg } = await this.classManager.inviteUser(inviteType, targetJid, name);
          let warningText = '';
          if (inviteMsg) {
            try {
              await this.notificationManager.sendMessage(targetJid, inviteMsg);
            } catch (sendErr: any) {
              await logAudit('WARN', 'INVITE_DM_SEND_FAILED', `Failed to send onboarding DM to ${targetJid}: ${sendErr.message}`);
              warningText = `\n⚠️ *Warning*: Onboarding DM could not be delivered: ${sendErr.message}`;
            }
          }
          const tipText = inviteType === 'student'
            ? `\n\n*Tip*: If they do not receive the message, please ask them to message this bot number first to bypass WhatsApp's new reach-out timelock.`
            : '';
          
          let successText = '';
          if (inviteType === 'teacher') {
            successText = `✅ Teacher *${name}* successfully registered in the database.`;
          } else if (isPending) {
            successText = `ℹ️ Student *${name}* was already invited but pending. Onboarding DM has been re-sent.${warningText}${tipText}`;
          } else {
            successText = `✅ Student *${name}* invited. Onboarding DM sent.${warningText}${tipText}`;
          }

          return {
            replyText: successText,
            shouldDeleteOriginal,
          };
        } catch (err: any) {
          return { replyText: `❌ Failed to execute invite command: ${err.message}`, shouldDeleteOriginal };
        }
      }

      case 'add': {
        const rawPhone = parsed.args[0];
        const classSubject = parsed.args.slice(1).join(' ').trim();
        const targetJid = this.parsePhoneJid(rawPhone);

        const workshop = await this.prisma.workshop.findFirst({
          where: { subject: { contains: classSubject, mode: 'insensitive' } },
        });

        if (!workshop) {
          const allWorkshops = await this.prisma.workshop.findMany({
            select: { subject: true }
          });
          const listStr = allWorkshops.map(w => `- ${w.subject}`).join('\n');
          return {
            replyText: `❌ Workshop class matching "${classSubject}" not found in database.\n\n` +
                       `⚙️ *Available class workshops*:\n${listStr || 'None configured yet.'}`,
            shouldDeleteOriginal
          };
        }

        try {
          const studentName = `Student-${rawPhone.replace(/\D/g, '')}`;
          const placeholderId = -Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 10000);
          const enrollResult = await this.classManager.enrollStudent(workshop.id, targetJid, studentName, placeholderId);
          const student = enrollResult.student;

          let addStatus = 'added';
          if (workshop.whatsappJid) {
            try {
              await this.whatsapp.addParticipants(workshop.whatsappJid, [targetJid]);
              await this.whatsapp.sendMessage(
                workshop.whatsappJid,
                `👋 Welcome *${student.name}* to our *${workshop.subject}* WhatsApp group class!`
              );
            } catch (addErr: any) {
              // Direct add failed (privacy settings). Fall back to invite link.
              try {
                const code = await this.whatsapp.getGroupInviteCode(workshop.whatsappJid);
                const inviteUrl = `https://chat.whatsapp.com/${code}`;
                
                await this.whatsapp.sendMessage(
                  targetJid,
                  `👋 Hello *${student.name}*!\n` +
                  `You have been enrolled in *${workshop.subject}* class.\n` +
                  `Please tap this link to join the class WhatsApp group:\n` +
                  `👉 ${inviteUrl}`
                );
                addStatus = 'invite link sent';
              } catch (inviteErr: any) {
                addStatus = `invite failed (${inviteErr.message})`;
              }
            }
          }

          if (addStatus === 'added') {
            return {
              replyText: `✅ Enrolled *${student.name}* in *${workshop.subject}* and added to WhatsApp group.`,
              shouldDeleteOriginal,
            };
          } else {
            return {
              replyText: `✅ Enrolled *${student.name}* in *${workshop.subject}* (Direct add blocked by privacy; group invite link DM-ed).`,
              shouldDeleteOriginal,
            };
          }
        } catch (err: any) {
          return { replyText: `❌ Failed to enroll student: ${err.message}`, shouldDeleteOriginal };
        }
      }

      case 'profile': {
        const rawPhone = parsed.args[0];
        const field = parsed.args[1].toLowerCase() as 'name' | 'id';
        const value = parsed.args.slice(2).join(' ').trim();

        try {
          const targetJid = this.parsePhoneJid(rawPhone);
          const res = await this.classManager.updateStudentProfile(targetJid, field, value);
          return { replyText: res.message, shouldDeleteOriginal };
        } catch (err: any) {
          let replyText = `❌ Failed to update profile: ${err.message}`;
          if (err.message.includes('not found in database')) {
            replyText = `❌ Student with phone/JID "${rawPhone}" not found in database.\n\n` +
                        `💡 *Suggestion*: To register this student, use: \`/invite student ${rawPhone} <name>\``;
          }
          return { replyText, shouldDeleteOriginal };
        }
      }

      case 'homework': {
        if (!workshopId) {
          return { replyText: '❌ This command requires a workshop context.', shouldDeleteOriginal: false };
        }

        if (parsed.role === 'teacher') {
          const isDelete = parsed.args[0] && parsed.args[0].toLowerCase() === 'delete';
          if (isDelete) {
            try {
              await this.homeworkManager.deleteHomework(workshopId, parsed.lessonId!);
              return {
                replyText: `✅ Successfully deleted homework assignment for lesson ID ${parsed.lessonId} from this class.`,
                shouldDeleteOriginal,
              };
            } catch (err: any) {
              return { replyText: `❌ Failed to delete homework: ${err.message}`, shouldDeleteOriginal };
            }
          } else {
            // Assign homework
            if (parsed.lessonId === null) {
              // Keyword search
              const courses = this.learndashSync.getCachedData();
              const query = parsed.args.join(' ').toLowerCase();
              const matches: { courseName: string; lessonId: number; lessonName: string }[] = [];

              for (const course of courses) {
                for (const lesson of course.lessons) {
                  if (
                    lesson.lessonName.toLowerCase().includes(query) ||
                    course.courseName.toLowerCase().includes(query)
                  ) {
                    matches.push({
                      courseName: course.courseName,
                      lessonId: lesson.lessonId,
                      lessonName: lesson.lessonName,
                    });
                  }
                }
              }

              if (matches.length === 1) {
                const match = matches[0];
                try {
                  const existingHw = await this.prisma.homework.findFirst({
                    where: { workshopId, lessonId: match.lessonId },
                  });
                  await this.homeworkManager.assignHomework(workshopId, match.lessonId, match.lessonName, parsed.dueDate!);
                  if (existingHw) {
                    return {
                      replyText: `📝 Homework *${match.lessonName}* was already assigned to this class. Due date has been updated to *${parsed.dueDate!.toDateString()}*.`,
                      shouldDeleteOriginal,
                    };
                  } else {
                    return {
                      replyText: `🔍 Found 1 matching lesson: *${match.courseName} - ${match.lessonName}*\n\n` +
                                 `📢 *New Homework Assigned!*\n\n📖 Lesson: *${match.lessonName}*\n📅 Due Date: ${parsed.dueDate!.toDateString()}\n\nComplete it on LearnDash!`,
                      shouldDeleteOriginal,
                      isAnnounce: true,
                    };
                  }
                } catch (err: any) {
                  return { replyText: `❌ Failed to assign homework: ${err.message}`, shouldDeleteOriginal };
                }
              } else if (matches.length > 1) {
                const list = matches
                  .slice(0, 10)
                  .map((m) => `- [ID: ${m.lessonId}] *${m.lessonName}* (${m.courseName})`)
                  .join('\n');
                return {
                  replyText: `🔍 Multiple matching lessons found. Please specify by ID:\n\n${list}`,
                  shouldDeleteOriginal,
                };
              } else {
                return {
                  replyText: `❌ No lessons found matching search query: "${parsed.args.join(' ')}"`,
                  shouldDeleteOriginal,
                };
              }
            } else {
              // Explicit ID assignment
              const courses = this.learndashSync.getCachedData();
              let title = `Lesson ${parsed.lessonId} Homework`;
              for (const course of courses) {
                const match = course.lessons.find((l) => l.lessonId === parsed.lessonId);
                if (match) {
                  title = match.lessonName;
                  break;
                }
              }

              try {
                const existingHw = await this.prisma.homework.findFirst({
                  where: { workshopId, lessonId: parsed.lessonId! },
                });
                await this.homeworkManager.assignHomework(workshopId, parsed.lessonId!, title, parsed.dueDate!);
                if (existingHw) {
                  return {
                    replyText: `📝 Homework *${title}* was already assigned to this class. Due date has been updated to *${parsed.dueDate!.toDateString()}*.`,
                    shouldDeleteOriginal,
                  };
                } else {
                  return {
                    replyText: `📢 *New Homework Assigned!*\n\n📖 Lesson: *${title}*\n📅 Due Date: ${parsed.dueDate!.toDateString()}\n\nComplete it on LearnDash!`,
                    shouldDeleteOriginal,
                    isAnnounce: true,
                  };
                }
              } catch (err: any) {
                return { replyText: `❌ Failed to assign homework: ${err.message}`, shouldDeleteOriginal };
              }
            }
          }
        } else {
          // Student role
          const textParts = msg.text.trim().split(/\s+/);
          const subCommand = (textParts[1] || '').toLowerCase();
          if (subCommand === 'done') {
            try {
              const { completedLog } = await this.homeworkManager.markHomeworkDone(resolvedSenderJid, msg.senderPn || undefined);
              if (!completedLog) {
                return {
                  replyText: '🎉 You have no pending homework tasks to mark as done!',
                  shouldDeleteOriginal: false,
                };
              }
              return {
                replyText: `✅ Marked homework *${completedLog.homework.title}* as completed! Great job!`,
                shouldDeleteOriginal: false,
              };
            } catch (err: any) {
              return { replyText: `❌ ${err.message}`, shouldDeleteOriginal: false };
            }
          } else {
            try {
              const pending = await this.homeworkManager.listPendingHomeworks(resolvedSenderJid, msg.senderPn || undefined);
              if (pending.length === 0) {
                return { replyText: '🎉 You have no pending homework tasks!', shouldDeleteOriginal: false };
              }
              const listText = pending
                .map((p) => `- *${p.homework.title}* (Due: ${p.homework.dueDate.toDateString()})`)
                .join('\n');
              return {
                replyText: `📖 *Your Pending Homework Tasks:*\n\n${listText}`,
                shouldDeleteOriginal: false,
              };
            } catch (err: any) {
              return { replyText: `❌ ${err.message}`, shouldDeleteOriginal: false };
            }
          }
        }
      }

      case 'meeting': {
        if (parsed.role === 'teacher' && parsed.args.length > 0) {
          let argsToProcess = parsed.args;
          if (argsToProcess[0]?.toLowerCase() === 'create') {
            argsToProcess = argsToProcess.slice(1);
          }

          const linkIndex = argsToProcess.findIndex(
            (arg) => arg.startsWith('http://') || arg.startsWith('https://')
          );
          let link: string | null = null;
          let classSubject = '';

          if (linkIndex !== -1) {
            link = argsToProcess[linkIndex];
            classSubject = argsToProcess.slice(0, linkIndex).join(' ').trim();
          } else {
            classSubject = argsToProcess.join(' ').trim();
          }

          let targetWorkshop: any = null;
          if (classSubject) {
            targetWorkshop = await this.prisma.workshop.findFirst({
              where: { subject: { contains: classSubject, mode: 'insensitive' } },
            });
            if (!targetWorkshop) {
              return { replyText: `❌ Workshop with subject "${classSubject}" not found.`, shouldDeleteOriginal };
            }
          } else {
            if (!workshopId) {
              return {
                replyText:
                  '❌ In a private chat, please specify the class subject. Usage: `/meeting [create] <class_subject> [<link>]`',
                shouldDeleteOriginal: false,
              };
            }
            targetWorkshop = await this.prisma.workshop.findUnique({
              where: { id: workshopId },
            });
          }

          if (!targetWorkshop) {
            return { replyText: '❌ Target workshop class not found.', shouldDeleteOriginal: false };
          }

          if (!link) {
            const letters = 'abcdefghijklmnopqrstuvwxyz';
            const randSegment = (len: number) =>
              Array.from({ length: len }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
            link = `https://meet.google.com/${randSegment(3)}-${randSegment(4)}-${randSegment(3)}`;
          }

          await this.prisma.workshop.update({
            where: { id: targetWorkshop.id },
            data: { meetingLink: link },
          });

          await logAudit(
            'INFO',
            'UPDATE_MEETING_LINK',
            `Teacher updated meeting link for workshop ${targetWorkshop.subject} to ${link}`,
            msg.senderJid
          );

          if (targetWorkshop.whatsappJid) {
            await this.notificationManager.sendMessage(
              targetWorkshop.whatsappJid,
              `📅 *Class Meeting Link Update*:\nThe meeting link for *${targetWorkshop.subject}* has been updated to:\n${link}`
            );
          }

          return {
            replyText: `✅ Meeting link updated for *${targetWorkshop.subject}*:\n${link}`,
            shouldDeleteOriginal,
          };
        } else {
          if (!workshopId) {
            return { replyText: '❌ This command requires a workshop context.', shouldDeleteOriginal: false };
          }
          const workshop = await this.prisma.workshop.findUnique({
            where: { id: workshopId },
          });
          const meetLink = workshop?.meetingLink || 'No class link is configured yet.';
          return { replyText: `📅 *Revision Workshop Meet Link*:\n${meetLink}`, shouldDeleteOriginal: false };
        }
      }

      case 'link': {
        if (parsed.role === 'student' && parsed.args.length > 0) {
          const student = await this.prisma.student.findUnique({
            where: { phoneNumber: resolvedSenderJid },
          });

          if (!student) {
            return { replyText: '❌ You are not registered as a student in the database.', shouldDeleteOriginal: false };
          }

          const userId = parseInt(parsed.args[0], 10);
          if (isNaN(userId) || userId <= 0) {
            return { replyText: '❌ LearnDash User ID must be a positive integer.', shouldDeleteOriginal: false };
          }

          const existing = await this.prisma.student.findUnique({
            where: { learndashId: userId },
          });
          if (existing && existing.phoneNumber !== resolvedSenderJid) {
            return {
              replyText: `❌ Error: LearnDash ID ${userId} is already linked to another student.`,
              shouldDeleteOriginal: false,
            };
          }

          const verifyRes = await this.learndashSync.verifyUserId(userId);
          if (!verifyRes.exists) {
            if (verifyRes.error) {
              await this.prisma.student.update({
                where: { id: student.id },
                data: { learndashId: userId },
              });
              await logAudit('INFO', 'STUDENT_LINK_SUCCESS', `Student linked LearnDash ID: ${userId}`, resolvedSenderJid);
              return {
                replyText: `⚠️ WordPress connection failed: ${verifyRes.error}. ID update bypassed and saved.\n\nYour profile is linked to LearnDash ID: *${userId}*`,
                shouldDeleteOriginal: false,
              };
            } else {
              return {
                replyText: `❌ WordPress Account ID ${userId} does not exist. Please check your ID and try again.`,
                shouldDeleteOriginal: false,
              };
            }
          }

          await this.prisma.student.update({
            where: { id: student.id },
            data: { learndashId: userId },
          });

          await logAudit('INFO', 'STUDENT_LINK_SUCCESS', `Student linked LearnDash ID: ${userId}`, resolvedSenderJid);
          return {
            replyText: `✅ Successfully linked your LearnDash Account ID *${userId}*!\n\nYour profile is linked to LearnDash ID: *${userId}*`,
            shouldDeleteOriginal: false,
          };
        } else {
          return {
            replyText:
              `ℹ️ *How to link your WordPress/LearnDash User ID*:\n\n` +
              `1. Log in to your account at *course.revision.my*\n` +
              `2. Tap on "Profile" (under the menu or avatar).\n` +
              `3. Locate your numeric *User ID* (displayed under your profile avatar/name, or visible in your browser profile URL).\n` +
              `4. Send a Direct Message (DM) to this bot containing only your numeric ID (e.g. *12345*), or run \`/link <id>\` in chat.\n\n` +
              `*Note*: If you cannot find your ID, please contact your teacher to link it for you using \`/profile <phone> id <id>\`.`,
            shouldDeleteOriginal: false,
          };
        }
      }

      case 'unlink': {
        if (parsed.role === 'teacher') {
          if (parsed.args.length === 0) {
            return {
              replyText: '❌ Please specify the student phone number to unlink. Usage: `/unlink <phone>`',
              shouldDeleteOriginal,
            };
          }
          const rawPhone = parsed.args[0];
          const targetJid = this.parsePhoneJid(rawPhone);

          try {
            const student = await this.prisma.student.findUnique({ where: { phoneNumber: targetJid } });
            if (!student) {
              return {
                replyText: `❌ Student with phone number "${rawPhone}" not found in database.`,
                shouldDeleteOriginal,
              };
            }

            const placeholderId = -Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 10000);
            await this.prisma.student.update({
              where: { id: student.id },
              data: { learndashId: placeholderId },
            });

            await logAudit('INFO', 'TEACHER_UNLINK_STUDENT', `Teacher unlinked student ID for ${targetJid}`, msg.senderJid);
            return {
              replyText: `✅ Successfully unlinked LearnDash ID for student *${student.name}*.`,
              shouldDeleteOriginal,
            };
          } catch (err: any) {
            return { replyText: `❌ Failed to unlink student: ${err.message}`, shouldDeleteOriginal };
          }
        } else {
          // Student self-unlink
          const student = await this.prisma.student.findUnique({
            where: { phoneNumber: resolvedSenderJid },
          });

          if (!student) {
            return { replyText: '❌ You are not registered in the database.', shouldDeleteOriginal: false };
          }

          const placeholderId = -Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 10000);
          await this.prisma.student.update({
            where: { id: student.id },
            data: { learndashId: placeholderId },
          });

          await logAudit('INFO', 'STUDENT_UNLINK_SELF', `Student unlinked their own ID`, resolvedSenderJid);
          return {
            replyText: `✅ Successfully unlinked your LearnDash ID. You can link a new ID at any time.`,
            shouldDeleteOriginal: false,
          };
        }
      }

      case 'remove': {
        const type = (parsed.args[0] || '').toLowerCase();
        const rawPhone = parsed.args[1];
        const subject = parsed.args.slice(2).join(' ').trim();

        if (!type || !rawPhone) {
          return {
            replyText: '❌ Invalid format. Use: `/remove student|teacher <phone> [<subject>]`',
            shouldDeleteOriginal: false,
          };
        }

        const targetJid = this.parsePhoneJid(rawPhone);

        try {
          if (type === 'teacher') {
            await this.classManager.removeUserGlobally('teacher', targetJid);
            return {
              replyText: `✅ Teacher ${rawPhone} successfully removed globally.`,
              shouldDeleteOriginal,
            };
          } else {
            // Student removal
            const isConfirm = parsed.args.length === 3 && parsed.args[2].toLowerCase() === 'confirm';
            const subjectVal = !isConfirm && parsed.args.slice(2).join(' ').trim();

            if (subjectVal) {
              // Unenroll student from specific class
              const res = await this.classManager.unenrollStudent(targetJid, subjectVal);
              
              // Kick student from the WhatsApp group of this class if it exists
              let groupKickMsg = '';
              if (res.enrollment.workshop.whatsappJid) {
                try {
                  await this.whatsapp.removeParticipants(res.enrollment.workshop.whatsappJid, [targetJid]);
                  groupKickMsg = ' and kicked from the WhatsApp group';
                } catch (grpErr: any) {
                  await logAudit('WARN', 'KICK_PARTICIPANT_FAILED', `Failed to kick student ${targetJid} from group: ${grpErr.message}`);
                  groupKickMsg = ` (failed to kick from WhatsApp group: ${grpErr.message})`;
                }
              }

              return {
                replyText: `✅ Student *${res.student.name}* successfully unenrolled from *${res.enrollment.workshop.subject}*${groupKickMsg}.`,
                shouldDeleteOriginal,
              };
            } else {
              // Global removal
              const student = await this.prisma.student.findUnique({
                where: { phoneNumber: targetJid },
                include: { enrollments: { include: { workshop: true } } },
              });

              if (!student) {
                return { replyText: `❌ Student with phone number ${rawPhone} not found.`, shouldDeleteOriginal };
              }

              const enrollments = student.enrollments || [];
              if (enrollments.length > 0 && !isConfirm) {
                const classList = enrollments.map((e) => `- *${e.workshop.subject}*`).join('\n');
                return {
                  replyText: `⚠️ *Warning*: Student *${student.name}* is currently enrolled in the following classes:\n\n` +
                    `${classList}\n\n` +
                    `Removing them globally will unenroll them from all these classes and **kick them from all WhatsApp groups**.\n\n` +
                    `To proceed, please reply with:\n` +
                    `\`/remove student ${rawPhone} confirm\``,
                  shouldDeleteOriginal: false,
                };
              }

              // Proceed with global removal (either no enrollments, or already confirmed)
              const kickStatus: string[] = [];
              for (const e of enrollments) {
                if (e.workshop.whatsappJid) {
                  try {
                    await this.whatsapp.removeParticipants(e.workshop.whatsappJid, [targetJid]);
                    kickStatus.push(`kicked from "${e.workshop.subject}"`);
                  } catch (kickErr: any) {
                    await logAudit('WARN', 'KICK_PARTICIPANT_FAILED', `Failed to kick student ${targetJid} from group ${e.workshop.whatsappJid}: ${kickErr.message}`);
                    kickStatus.push(`failed to kick from "${e.workshop.subject}" (${kickErr.message})`);
                  }
                }
              }

              const res = await this.classManager.removeUserGlobally('student', targetJid);
              const groupKickMsg = kickStatus.length > 0
                ? `\n\n👥 *Group Kicks*:\n${kickStatus.map(s => `- ${s}`).join('\n')}`
                : '';
              return {
                replyText: `✅ Student *${res.name}* successfully removed globally from the database${groupKickMsg}.`,
                shouldDeleteOriginal,
              };
            }
          }
        } catch (err: any) {
          return { replyText: `❌ Failed to execute remove command: ${err.message}`, shouldDeleteOriginal };
        }
      }

      case 'class': {
        const subAction = parsed.args[0].toLowerCase();
        const daysList = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

        if (subAction === 'list') {
          const classes = await this.classManager.listClasses();
          if (classes.length === 0) {
            return { replyText: '📋 *No workshops registered yet.*', shouldDeleteOriginal };
          }
          let listMsg = `📋 *All Registered Classes (${classes.length}):*\n\n`;
          for (const w of classes) {
            listMsg +=
              `- *${w.subject}* (ID: ${w.id})\n` +
              `  Course ID: ${w.courseId}\n` +
              `  Teacher: ${w.teacher.name} (${w.teacher.phoneNumber.split('@')[0]})\n` +
              `  Schedule: Every ${daysList[w.classDayOfWeek]} at ${w.classTime}\n` +
              `  Link: ${w.meetingLink || 'None'}\n\n`;
          }
          return { replyText: listMsg.trim(), shouldDeleteOriginal };
        } else if (subAction === 'create') {
          const createParams = this.classManager.parseClassCreationArgs(parsed.args.slice(1));
          if (!createParams) {
            return {
              replyText:
                '❌ Invalid arguments for `/class create`. Format:\n' +
                '`/class create <subject> <courseId> <day> <time> <teacher_phone> <teacher_name>`\n' +
                'Example: `/class create SPM Physics 101 Monday 20:00 60123456789 John Doe`',
              shouldDeleteOriginal,
            };
          }
          try {
            const classObj = await this.classManager.createClass(createParams);

            let groupCreatedText = '';
            if (this.whatsapp.isConnected()) {
              try {
                const groupName = `${classObj.subject} - Class`;
                const groupJid = await this.whatsapp.createGroup(groupName, [classObj.teacher.phoneNumber]);
                
                // Save the group JID to the database
                await this.prisma.workshop.update({
                  where: { id: classObj.id },
                  data: { whatsappJid: groupJid },
                });

                // Promote teacher to group admin
                await this.whatsapp.promoteAdmins(groupJid, [classObj.teacher.phoneNumber]);
                groupCreatedText = `\n👥 *WhatsApp Group Created*: "${groupName}" (promoted teacher to admin)`;
              } catch (grpErr: any) {
                await logAudit('WARN', 'CLASS_CREATE_GROUP_FAILED', `Failed to automatically create WhatsApp group for class: ${grpErr.message}`);
                groupCreatedText = `\n⚠️ *WhatsApp Group Creation Failed*: ${grpErr.message}`;
              }
            } else {
              groupCreatedText = `\n⚠️ *WhatsApp Group not created*: WhatsApp client is not connected.`;
            }

            return {
              replyText:
                `✅ *Workshop Successfully Created!*\n\n` +
                `🏫 *Subject*: ${classObj.subject}\n` +
                `🆔 *Course ID*: ${classObj.courseId}\n` +
                `📅 *Schedule*: Every ${daysList[classObj.classDayOfWeek]} at ${classObj.classTime}\n` +
                `👩‍🏫 *Teacher*: ${classObj.teacher.name} (${classObj.teacher.phoneNumber.split('@')[0]})\n` +
                `📅 *Class Link*: ${classObj.meetingLink}` +
                groupCreatedText,
              shouldDeleteOriginal,
            };
          } catch (err: any) {
            return { replyText: `❌ Failed to create class: ${err.message}`, shouldDeleteOriginal };
          }
        } else {
          // delete or archive
          const query = parsed.args.slice(1).join(' ').trim();
          if (!query) {
            return {
              replyText: '❌ Please specify the class subject or ID to delete/archive. Format: `/class delete <subject_or_id>`',
              shouldDeleteOriginal,
            };
          }
          try {
            const classObj = await this.classManager.deleteClass(query);
            return {
              replyText: `✅ Workshop "${classObj.subject}" has been successfully deleted.`,
              shouldDeleteOriginal,
            };
          } catch (err: any) {
            return { replyText: `❌ Failed to delete class: ${err.message}`, shouldDeleteOriginal };
          }
        }
      }

      case 'report': {
        try {
          const phoneArgIndex = parsed.args.findIndex((arg) =>
          /^\d{8,15}$/.test(arg.replace(/[@s\.whatsapp\.net]/g, ''))
        );
        let phone: string | null = null;
        let groupArgs = parsed.args;

        if (phoneArgIndex !== -1) {
          phone = parsed.args[phoneArgIndex];
          if (!phone.includes('@')) {
            phone = `${phone}@s.whatsapp.net`;
          }
          groupArgs = parsed.args.filter((_, idx) => idx !== phoneArgIndex);
        }

        const groupName = groupArgs.join(' ').trim();
        const targetDmJid = msg.senderJid;

        // Case A: Both phone and group name specified
        if (phone && groupName) {
          const w = await this.prisma.workshop.findFirst({
            where: { subject: { contains: groupName, mode: 'insensitive' } },
          });
          if (!w) {
            return { replyText: `❌ Workshop with subject "${groupName}" not found.`, shouldDeleteOriginal };
          }
          const student = await this.prisma.student.findUnique({
            where: { phoneNumber: phone },
            include: {
              progress: {
                where: { homework: { workshopId: w.id } },
                include: { homework: true },
              },
            },
          });
          if (!student) {
            return { replyText: `❌ Student with phone number "${phone.split('@')[0]}" not found.`, shouldDeleteOriginal };
          }

          let details = '';
          for (const p of student.progress) {
            let statusIcon = '🔴';
            if (p.status === ProgressStatus.COMPLETED) statusIcon = '🟢';
            if (p.status === ProgressStatus.IN_PROGRESS) statusIcon = '🟡';
            if (p.status === ProgressStatus.SKIPPED_EXERCISES) statusIcon = '🟠';
            details += `- *${p.homework.title}*: ${statusIcon} ${p.status.replace('_', ' ')}\n`;
          }

          const reportText =
            `👤 *Student Progress Report: ${student.name}* 👤\n` +
            `🏫 Class: *${w.subject}*\n` +
            `📞 Phone: ${student.phoneNumber.split('@')[0]}\n` +
            `🆔 LearnDash ID: ${student.learndashId}\n\n` +
            `*Homework Progress:*\n${details || 'No homework assigned yet.'}`;

          await this.notificationManager.sendMessage(targetDmJid, reportText);
          await logAudit('INFO', 'SEND_MANUAL_REPORT', `Sent student report for ${student.name} to teacher.`, targetDmJid);
          return {
            replyText: `📩 I have sent the progress report for student *${student.name}* in *${w.subject}* to your private DM.`,
            shouldDeleteOriginal,
          };
        }

        // Case B: Only phone specified
        if (phone && !groupName) {
          const student = await this.prisma.student.findUnique({
            where: { phoneNumber: phone },
            include: {
              progress: {
                include: {
                  homework: {
                    include: { workshop: true },
                  },
                },
              },
            },
          });
          if (!student) {
            return { replyText: `❌ Student with phone number "${phone.split('@')[0]}" not found.`, shouldDeleteOriginal };
          }

          let details = '';
          for (const p of student.progress) {
            let statusIcon = '🔴';
            if (p.status === ProgressStatus.COMPLETED) statusIcon = '🟢';
            if (p.status === ProgressStatus.IN_PROGRESS) statusIcon = '🟡';
            if (p.status === ProgressStatus.SKIPPED_EXERCISES) statusIcon = '🟠';
            details += `- *${p.homework.title}* (${p.homework.workshop.subject}): ${statusIcon} ${p.status.replace('_', ' ')}\n`;
          }

          const reportText =
            `👤 *Student Progress Report: ${student.name}* 👤\n` +
            `📞 Phone: ${student.phoneNumber.split('@')[0]}\n` +
            `🆔 LearnDash ID: ${student.learndashId}\n\n` +
            `*Homework Progress:*\n${details || 'No homework assigned yet.'}`;

          await this.notificationManager.sendMessage(targetDmJid, reportText);
          await logAudit('INFO', 'SEND_MANUAL_REPORT', `Sent student report for ${student.name} to teacher.`, targetDmJid);
          return {
            replyText: `📩 I have sent the progress report for student *${student.name}* to your private DM.`,
            shouldDeleteOriginal,
          };
        }

        // Case C: Only group name specified
        if (!phone && groupName) {
          const w = await this.prisma.workshop.findFirst({
            where: { subject: { contains: groupName, mode: 'insensitive' } },
          });
          if (!w) {
            return { replyText: `❌ Workshop with subject "${groupName}" not found.`, shouldDeleteOriginal };
          }

          const reportText = await this.compileProgressReport(w.id);
          await this.notificationManager.sendMessage(targetDmJid, reportText);
          await logAudit('INFO', 'SEND_MANUAL_REPORT', `Sent group report for workshop ${w.subject} to teacher.`, targetDmJid);
          return {
            replyText: `📩 I have sent the progress report for workshop *${w.subject}* to your private DM.`,
            shouldDeleteOriginal,
          };
        }

        // Case D: Neither phone nor group name specified
        if (!phone && !groupName) {
          if (!workshopId) {
            return {
              replyText:
                '❌ In a private chat, please specify the class subject or student phone number. Usage: `/report [<group_name>] [<phone_number>]`',
              shouldDeleteOriginal: false,
            };
          }

          const w = await this.prisma.workshop.findUnique({ where: { id: workshopId } });
          const subject = w ? w.subject : '';
          const reportText = await this.compileProgressReport(workshopId);
          await this.notificationManager.sendMessage(targetDmJid, reportText);
          return {
            replyText: `📩 I have sent the progress report for workshop *${subject}* to your private DM.`,
            shouldDeleteOriginal,
          };
        }
      } catch (err: any) {
        return { replyText: `❌ Failed to compile progress report: ${err.message}`, shouldDeleteOriginal };
      }
      break;
    }

      case 'students': {
        try {
          const cleanSender = msg.senderJid.split('@')[0];
          const cleanSenderPn = msg.senderPn ? msg.senderPn.split('@')[0] : null;
          const cleanAdmin = CONFIG.BOT.PHONE_NUMBER.replace(/\D/g, '');
          const isSelfMessage = !!(msg.rawKey && msg.rawKey.fromMe);

          const isAdmin = isSelfMessage || (cleanAdmin && (cleanSender === cleanAdmin || cleanSenderPn === cleanAdmin));

          // Check if DM (private chat)
          if (!msg.isGroup) {
            if (isAdmin) {
              // Show all students globally
              const students = await this.prisma.student.findMany({
                orderBy: { name: 'asc' },
              });
              if (students.length === 0) {
                return { replyText: '📋 *No students registered globally in the database.*', shouldDeleteOriginal };
              }
              const studentsList = students
                .map((s, idx) => `${idx + 1}. ${s.name} (${s.phoneNumber.split('@')[0]})`)
                .join('\n');
              return {
                replyText: `📋 *All Registered Students (Global):*\n\n${studentsList}`,
                shouldDeleteOriginal,
              };
            } else {
              // Show all students enrolled in any of this teacher's workshops
              const teacherWorkshops = await this.prisma.workshop.findMany({
                where: {
                  teacher: {
                    phoneNumber: {
                      in: [msg.senderJid, msg.senderPn || ''].filter(Boolean)
                    }
                  }
                },
                include: { students: { include: { student: true } } },
                orderBy: { subject: 'asc' },
              });

              if (teacherWorkshops.length === 0) {
                return { replyText: '📋 *You do not have any registered classes.*', shouldDeleteOriginal };
              }

              // Extract unique students across all teacher's workshops
              const uniqueStudentsMap = new Map<string, any>();
              for (const w of teacherWorkshops) {
                for (const s of w.students) {
                  uniqueStudentsMap.set(s.student.phoneNumber, s.student);
                }
              }

              if (uniqueStudentsMap.size === 0) {
                return { replyText: '📋 *No students enrolled in your classes.*', shouldDeleteOriginal };
              }

              const studentsList = Array.from(uniqueStudentsMap.values())
                .map((s, idx) => `${idx + 1}. ${s.name} (${s.phoneNumber.split('@')[0]})`)
                .join('\n');

              return {
                replyText: `📋 *Your Students (across all your classes):*\n\n${studentsList}`,
                shouldDeleteOriginal,
              };
            }
          }

          // Standard: Group chat (workshop-specific)
          if (!workshopId) {
            return { replyText: '❌ This command requires a workshop context.', shouldDeleteOriginal: false };
          }
          const workshop = await this.prisma.workshop.findUnique({
            where: { id: workshopId },
            include: { students: { include: { student: true } } },
          });
          if (!workshop || workshop.students.length === 0) {
            return { replyText: '📋 *No students enrolled in this class.*', shouldDeleteOriginal };
          }
          const studentsList = workshop.students
            .map((s, idx) => `${idx + 1}. ${s.student.name} (${s.student.phoneNumber.split('@')[0]})`)
            .join('\n');
          return {
            replyText: `📋 *Enrolled Students in ${workshop.subject}:*\n\n${studentsList}`,
            shouldDeleteOriginal,
          };
        } catch (err: any) {
          return { replyText: `❌ Failed to list students: ${err.message}`, shouldDeleteOriginal };
        }
      }

      case 'check': {
        try {
          if (!workshopId) {
            return { replyText: '❌ This command requires a workshop context.', shouldDeleteOriginal: false };
          }
          const searchName = parsed.args.join(' ').trim();
          if (!searchName) {
            return { replyText: '❌ Please specify student name. Format: `/check <student_name>`', shouldDeleteOriginal };
          }

          const enrollment = await this.prisma.studentWorkshop.findFirst({
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
            return {
              replyText: `❌ No student found matching "${searchName}" in this class.`,
              shouldDeleteOriginal,
            };
          }

          const student = enrollment.student;
          const progressLines =
            student.progress.length === 0
              ? 'No active homework logs.'
              : student.progress
                  .map((p) => `- *${p.homework.title}*: ${p.status.replace('_', ' ')} (Score: ${p.score ?? 'N/A'})`)
                  .join('\n');

          return {
            replyText:
              `👤 *Student Audit: ${student.name}*\n` +
              `📞 Phone: ${student.phoneNumber.split('@')[0]}\n` +
              `🆔 LearnDash ID: ${student.learndashId}\n\n` +
              `*Progress History:*\n${progressLines}`,
            shouldDeleteOriginal,
          };
        } catch (err: any) {
          return { replyText: `❌ Failed to check student progress: ${err.message}`, shouldDeleteOriginal };
        }
      }
    }

    return null;
  }

  async compileProgressReport(workshopId: string): Promise<string> {
    const workshop = await this.prisma.workshop.findUnique({
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

    if (!workshop || !workshop.homeworks || workshop.homeworks.length === 0) {
      return '📋 *Class Progress Report*:\nNo homework logs found for this workshop.';
    }

    const latestHomework = workshop.homeworks[0];
    const logs = latestHomework.progress;

    const total = logs.length;
    const completed = logs.filter((l) => l.status === ProgressStatus.COMPLETED).length;
    const skipped = logs.filter((l) => l.status === ProgressStatus.SKIPPED_EXERCISES).length;
    const inProgress = logs.filter((l) => l.status === ProgressStatus.IN_PROGRESS).length;
    const notStarted = logs.filter((l) => l.status === ProgressStatus.NOT_STARTED).length;

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
