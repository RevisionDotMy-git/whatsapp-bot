import { PrismaClient } from '@prisma/client';
import { logAudit } from '../../services/db.js';
import { ILearnDashSync } from '../learndashSync/ILearnDashSync.js';
import { IClassManager, ClassCreationParams } from './IClassManager.js';

export class ClassManager implements IClassManager {
  private prisma: PrismaClient;
  private learndash?: ILearnDashSync;

  constructor(prisma: PrismaClient, learndash?: ILearnDashSync) {
    this.prisma = prisma;
    this.learndash = learndash;
  }

  async listClasses(): Promise<any[]> {
    return this.prisma.workshop.findMany({
      include: { teacher: true },
      orderBy: { subject: 'asc' },
    });
  }

  async createClass(params: ClassCreationParams): Promise<any> {
    const existing = await this.prisma.workshop.findFirst({
      where: { subject: params.subject },
    });
    if (existing) {
      throw new Error(`A workshop with subject "${params.subject}" already exists.`);
    }

    // Upsert teacher
    const teacher = await this.prisma.teacher.upsert({
      where: { phoneNumber: params.teacherPhone },
      create: { name: params.teacherName, phoneNumber: params.teacherPhone },
      update: { name: params.teacherName },
    });

    // Generate default Google Meet link
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    const randSegment = (len: number) =>
      Array.from({ length: len }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    const defaultLink = `https://meet.google.com/${randSegment(3)}-${randSegment(4)}-${randSegment(3)}`;

    // Create workshop
    const workshop = await this.prisma.workshop.create({
      data: {
        subject: params.subject,
        courseId: params.courseId,
        classDayOfWeek: params.dayOfWeek,
        classTime: params.time,
        teacherId: teacher.id,
        meetingLink: defaultLink,
      },
      include: { teacher: true },
    });

    await logAudit('INFO', 'CREATE_CLASS', `Class "${workshop.subject}" (ID: ${workshop.id}) created for teacher ${teacher.name}`);
    return workshop;
  }

  async deleteClass(subjectOrId: string): Promise<any> {
    const workshop = await this.prisma.workshop.findFirst({
      where: {
        OR: [
          { id: subjectOrId },
          { subject: { equals: subjectOrId, mode: 'insensitive' } },
        ],
      },
    });

    if (!workshop) {
      throw new Error(`Class with subject or ID "${subjectOrId}" not found.`);
    }

    await this.prisma.workshop.delete({
      where: { id: workshop.id },
    });

    await logAudit('INFO', 'DELETE_CLASS', `Class "${workshop.subject}" (ID: ${workshop.id}) was deleted`);
    return workshop;
  }

  async enrollStudent(workshopId: string, studentJid: string, name: string, learndashId: number): Promise<any> {
    const student = await this.prisma.student.upsert({
      where: { phoneNumber: studentJid },
      create: {
        name,
        phoneNumber: studentJid,
        learndashId,
      },
      update: {
        name,
        learndashId,
      },
    });

    const enrollment = await this.prisma.studentWorkshop.upsert({
      where: {
        studentId_workshopId: {
          studentId: student.id,
          workshopId,
        },
      },
      update: {},
      create: {
        studentId: student.id,
        workshopId,
      },
    });

    // Generate progress logs for existing homework tasks in this workshop
    const homeworks = await this.prisma.homework.findMany({
      where: { workshopId },
    });

    for (const hw of homeworks || []) {
      await this.prisma.progressLog.upsert({
        where: {
          studentId_homeworkId: {
            studentId: student.id,
            homeworkId: hw.id,
          },
        },
        update: {},
        create: {
          studentId: student.id,
          homeworkId: hw.id,
          status: 'NOT_STARTED',
        },
      });
    }

    await logAudit('INFO', 'STUDENT_ENROLL', `Student ${student.name} (${student.phoneNumber}) enrolled in workshop ${workshopId}`);
    return { student, enrollment };
  }

  async unenrollStudent(studentJid: string, subject: string): Promise<any> {
    const student = await this.prisma.student.findUnique({
      where: { phoneNumber: studentJid },
      include: { enrollments: { include: { workshop: true } } },
    });

    if (!student) {
      throw new Error('Student not found.');
    }

    const enrollment = student.enrollments.find(
      (e) => e.workshop.subject.toLowerCase() === subject.toLowerCase()
    );

    if (!enrollment) {
      throw new Error(`Student is not enrolled in class: ${subject}`);
    }

    await this.prisma.studentWorkshop.delete({
      where: {
        studentId_workshopId: {
          studentId: student.id,
          workshopId: enrollment.workshopId,
        },
      },
    });

    await logAudit('INFO', 'STUDENT_UNENROLL', `Student ${student.name} unenrolled from class "${subject}"`);
    return { student, enrollment };
  }

  async removeUserGlobally(role: 'student' | 'teacher', jid: string): Promise<any> {
    if (role === 'teacher') {
      const teacher = await this.prisma.teacher.findUnique({
        where: { phoneNumber: jid },
        include: { workshops: true },
      });

      if (!teacher) {
        throw new Error('Teacher not found.');
      }

      if (teacher.workshops.length > 0) {
        throw new Error(
          `Cannot delete teacher. They are assigned to active classes: ${teacher.workshops
            .map((w) => w.subject)
            .join(', ')}`
        );
      }

      await this.prisma.teacher.delete({
        where: { id: teacher.id },
      });

      await logAudit('INFO', 'TEACHER_REMOVE_GLOBAL', `Teacher ${teacher.name} (${teacher.phoneNumber}) removed globally`);
      return teacher;
    } else {
      const student = await this.prisma.student.findUnique({
        where: { phoneNumber: jid },
      });

      if (!student) {
        throw new Error('Student not found.');
      }

      await this.prisma.student.delete({
        where: { id: student.id },
      });

      await logAudit('INFO', 'STUDENT_REMOVE_GLOBAL', `Student ${student.name} (${student.phoneNumber}) removed globally`);
      return student;
    }
  }

  parseClassCreationArgs(args: string[]): ClassCreationParams | null {
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
      teacherName,
    };
  }

  async inviteUser(role: 'student' | 'teacher', phone: string, name: string): Promise<{ user: any, inviteMsg?: string }> {
    const targetJid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

    if (role === 'teacher') {
      const oppositeStudent = await this.prisma.student.findUnique({
        where: { phoneNumber: targetJid }
      });
      if (oppositeStudent) {
        throw new Error(`The phone number ${phone} is already registered as a Student (*${oppositeStudent.name}*) in the database. A number cannot be both a student and a teacher.`);
      }

      const teacher = await this.prisma.teacher.upsert({
        where: { phoneNumber: targetJid },
        create: { name, phoneNumber: targetJid },
        update: { name }
      });

      const inviteMsg =
        `👋 Hello Teacher *${name}*!\n` +
        `You have been registered as an authorized teacher in the Revision Workshop Class Assistant Bot.\n` +
        `Type \`/help\` to see the list of available commands.`;

      await logAudit('INFO', 'TEACHER_INVITED', `Teacher ${name} invited: ${targetJid}`);
      return { user: teacher, inviteMsg };
    } else {
      const oppositeTeacher = await this.prisma.teacher.findUnique({
        where: { phoneNumber: targetJid }
      });
      if (oppositeTeacher) {
        throw new Error(`The phone number ${phone} is already registered as a Teacher (*${oppositeTeacher.name}*) in the database. A number cannot be both a student and a teacher.`);
      }

      let student = await this.prisma.student.findUnique({
        where: { phoneNumber: targetJid }
      });

      const placeholderId = -Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 10000);

      if (!student) {
        student = await this.prisma.student.create({
          data: {
            name,
            phoneNumber: targetJid,
            learndashId: placeholderId
          }
        });
      } else {
        if (student.learndashId >= 0) {
          throw new Error(`Student *${name}* is already registered and linked (ID: ${student.learndashId}).`);
        }
      }

      const inviteMsg =
        `👋 Hello *${name}*!\n` +
        `You have been invited to Revision Workshops class tracking.\n\n` +
        `Please reply directly to this message with your *WordPress/LearnDash User ID* (numbers only) to link your account.\n\n` +
        `👉 Reply with: your ID number (e.g. *12345*)\n` +
        `❌ Reply with: *N/A* to cancel this update.\n\n` +
        `ℹ️ *How to find your LearnDash User ID*:\n` +
        `1. Log in to your account at *course.revision.my*\n` +
        `2. Tap on "Profile" (under the menu or avatar).\n` +
        `3. Your User ID is displayed under your profile avatar/name, or visible in your browser profile URL.`;

      await logAudit('INFO', 'STUDENT_INVITED', `Student ${name} invited: ${targetJid}`);
      return { user: student, inviteMsg };
    }
  }

  async updateStudentProfile(phone: string, field: 'name' | 'id', value: string): Promise<{ success: boolean; message: string; verifyWarning?: boolean }> {
    const targetJid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

    const student = await this.prisma.student.findUnique({
      where: { phoneNumber: targetJid }
    });

    if (!student) {
      throw new Error(`Student with phone/JID "${phone}" not found in database.`);
    }

    if (field === 'name') {
      await this.prisma.student.update({
        where: { id: student.id },
        data: { name: value }
      });
      await logAudit('INFO', 'TEACHER_UPDATE_STUDENT_NAME', `Teacher updated student ${student.phoneNumber} name to "${value}"`);
      return { success: true, message: `Successfully updated student name to *${value}*.` };
    } else {
      const userId = parseInt(value, 10);
      if (isNaN(userId) || userId <= 0) {
        throw new Error('LearnDash ID must be a positive integer.');
      }

      const existing = await this.prisma.student.findUnique({
        where: { learndashId: userId }
      });
      if (existing && existing.id !== student.id) {
        throw new Error(`LearnDash ID ${userId} is already linked to student *${existing.name}*.\n\n👉 *Suggestion*: If you want to move this ID, update the other student's profile to another ID or "N/A" first.`);
      }

      let verifyWarning = false;
      if (this.learndash) {
        const verifyRes = await this.learndash.verifyUserId(userId);
        if (!verifyRes.exists) {
          if (verifyRes.error) {
            verifyWarning = true;
          } else {
            throw new Error(`LearnDash account ID ${userId} was not found on WordPress.`);
          }
        }
      }

      await this.prisma.student.update({
        where: { id: student.id },
        data: { learndashId: userId }
      });

      await logAudit('INFO', 'TEACHER_UPDATE_STUDENT_LD_ID', `Teacher updated student ${student.phoneNumber} ID to ${userId}`);
      
      let message = `Successfully updated student *${student.name}* LearnDash ID to *${userId}*.`;
      if (verifyWarning) {
        message = `⚠️ Verification connection error. LearnDash ID *${userId}* update bypassed and saved anyway.`;
      }
      return { success: true, message, verifyWarning };
    }
  }
}
