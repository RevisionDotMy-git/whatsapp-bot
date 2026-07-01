import { IncomingMessage } from '../../interfaces/IWhatsAppClient.js';

export interface IHomeworkManager {
  assignHomework(workshopId: string, lessonId: number, title: string, dueDate: Date): Promise<any>;
  deleteHomework(workshopId: string, lessonId: number): Promise<void>;
  listHomeworks(workshopId: string): Promise<any[]>;
  markHomeworkDone(studentJid: string, altJid?: string): Promise<any>;
  listPendingHomeworks(studentJid: string, altJid?: string): Promise<any[]>;
  detectCustomHomework(
    msg: IncomingMessage,
    workshopId: string,
    enrolledStudentJids: string[]
  ): Promise<{ fileFormat: string; dueDate: Date; title: string; defaultSuffix: string; homeworkId: string } | null>;
}
