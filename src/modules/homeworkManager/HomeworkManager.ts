import { PrismaClient } from '@prisma/client';
import { logAudit } from '../../services/db.js';
import { IncomingMessage } from '../../interfaces/IWhatsAppClient.js';
import { IHomeworkManager } from './IHomeworkManager.js';
import { parseDueDate } from '../../utils/dateParser.js';

export class HomeworkManager implements IHomeworkManager {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async assignHomework(workshopId: string, lessonId: number, title: string, dueDate: Date): Promise<any> {
    let homework = await this.prisma.homework.findFirst({
      where: {
        workshopId,
        lessonId,
      },
    });

    if (homework) {
      homework = await this.prisma.homework.update({
        where: { id: homework.id },
        data: { dueDate },
      });
    } else {
      homework = await this.prisma.homework.create({
        data: {
          workshopId,
          lessonId,
          title,
          dueDate,
        },
      });

      // Create initial ProgressLogs for all enrolled students
      const enrollments = await this.prisma.studentWorkshop.findMany({
        where: { workshopId },
      });

      for (const enrollment of enrollments) {
        await this.prisma.progressLog.upsert({
          where: {
            studentId_homeworkId: {
              studentId: enrollment.studentId,
              homeworkId: homework.id,
            },
          },
          update: {},
          create: {
            studentId: enrollment.studentId,
            homeworkId: homework.id,
            status: 'NOT_STARTED',
          },
        });
      }
    }

    await logAudit(
      'INFO',
      'HOMEWORK_ASSIGN',
      `Homework for lesson ${lessonId} ("${title}") assigned to class ${workshopId} with due date ${dueDate.toISOString()}`
    );

    return homework;
  }

  async deleteHomework(workshopId: string, lessonId: number): Promise<void> {
    const homework = await this.prisma.homework.findFirst({
      where: { workshopId, lessonId },
    });

    if (!homework) {
      throw new Error(`Homework with lesson ID ${lessonId} not found in this class.`);
    }

    await this.prisma.homework.delete({
      where: { id: homework.id },
    });

    await logAudit(
      'INFO',
      'HOMEWORK_DELETE',
      `Homework for lesson ${lessonId} deleted from class ${workshopId}`
    );
  }

  async listHomeworks(workshopId: string): Promise<any[]> {
    return this.prisma.homework.findMany({
      where: { workshopId },
      orderBy: { dueDate: 'asc' },
    });
  }

  async markHomeworkDone(studentJid: string, altJid?: string): Promise<any> {
    let student = await this.prisma.student.findUnique({
      where: { phoneNumber: studentJid },
    });

    if (!student && altJid) {
      student = await this.prisma.student.findUnique({
        where: { phoneNumber: altJid },
      });
    }

    if (!student) {
      throw new Error('You are not registered as a student in the database.');
    }

    const oldestPending = await this.prisma.progressLog.findFirst({
      where: {
        studentId: student.id,
        status: { not: 'COMPLETED' },
      },
      include: { homework: true },
      orderBy: { homework: { dueDate: 'asc' } },
    });

    if (!oldestPending) {
      return { student, completedLog: null };
    }

    const updatedLog = await this.prisma.progressLog.update({
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

    return { student, completedLog: updatedLog };
  }

  async listPendingHomeworks(studentJid: string, altJid?: string): Promise<any[]> {
    let student = await this.prisma.student.findUnique({
      where: { phoneNumber: studentJid },
    });

    if (!student && altJid) {
      student = await this.prisma.student.findUnique({
        where: { phoneNumber: altJid },
      });
    }

    if (!student) {
      throw new Error('You are not registered as a student in the database.');
    }

    return this.prisma.progressLog.findMany({
      where: {
        studentId: student.id,
        status: { not: 'COMPLETED' },
      },
      include: { homework: true },
      orderBy: { homework: { dueDate: 'asc' } },
    });
  }

  async detectCustomHomework(
    msg: IncomingMessage,
    workshopId: string,
    enrolledStudentJids: string[]
  ): Promise<{ fileFormat: string; dueDate: Date; title: string; defaultSuffix: string; homeworkId: string } | null> {
    const textContent = msg.text || '';
    const hasDoc = !!msg.document;
    const hasGoogleLink = textContent.includes('drive.google.com') || textContent.includes('docs.google.com');

    if (!hasDoc && !hasGoogleLink) {
      return null;
    }

    // Determine format
    let fileFormat = 'unknown';

    if (hasDoc && msg.document) {
      const mime = msg.document.mimetype || '';
      const fileTitle = msg.document.fileName || 'Homework File';
      if (mime.includes('pdf')) {
        fileFormat = 'pdf';
      } else if (mime.includes('word') || mime.includes('officedocument') || fileTitle.endsWith('.docx') || fileTitle.endsWith('.doc')) {
        fileFormat = 'docx';
      } else {
        fileFormat = 'document';
      }
    } else if (hasGoogleLink) {
      fileFormat = 'drive link';
    }

    // Determine due date (check message text or caption)
    let dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7); // Default 7 days
    let defaultSuffix = '7 days';

    const parsedDue = parseDueDate(textContent);
    if (parsedDue) {
      dueDate = parsedDue.date;
      defaultSuffix = parsedDue.reason;
    }

    const uniqueId = -Math.floor(Date.now() / 1000);
    const title = `Custom Homework (${fileFormat})`;

    // Register custom homework in database
    const homework = await this.prisma.homework.create({
      data: {
        workshopId,
        lessonId: uniqueId,
        title,
        dueDate,
      },
    });

    // Create progress logs for all enrolled students
    const students = await this.prisma.student.findMany({
      where: { phoneNumber: { in: enrolledStudentJids } },
    });

    for (const student of students) {
      await this.prisma.progressLog.create({
        data: {
          studentId: student.id,
          homeworkId: homework.id,
          status: 'NOT_STARTED',
        },
      });
    }

    const auditDetails = `homework detected at ${new Date().toISOString()} with ${fileFormat}`;
    await logAudit(
      'INFO',
      'CUSTOM_HOMEWORK_DETECTED',
      auditDetails,
      msg.senderJid
    );

    return {
      fileFormat,
      dueDate,
      title,
      defaultSuffix,
      homeworkId: homework.id,
    };
  }
}
