export interface ClassCreationParams {
  subject: string;
  courseId: number;
  dayOfWeek: number;
  time: string;
  teacherPhone: string;
  teacherName: string;
}

export interface IClassManager {
  listClasses(): Promise<any[]>;
  createClass(params: ClassCreationParams): Promise<any>;
  deleteClass(subjectOrId: string): Promise<any>;
  enrollStudent(workshopId: string, studentJid: string, name: string, learndashId: number): Promise<any>;
  unenrollStudent(studentJid: string, subject: string): Promise<any>;
  removeUserGlobally(role: 'student' | 'teacher', jid: string): Promise<any>;
  parseClassCreationArgs(args: string[]): ClassCreationParams | null;
  inviteUser(role: 'student' | 'teacher', phone: string, name: string): Promise<{ user: any, inviteMsg?: string }>;
  updateStudentProfile(phone: string, field: 'name' | 'id', value: string): Promise<{ success: boolean; message: string; verifyWarning?: boolean }>;
}
