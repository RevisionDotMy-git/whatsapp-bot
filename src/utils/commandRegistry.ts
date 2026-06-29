export type UserRole = 'teacher' | 'student';
export type Accessibility = 'group' | 'private';

export interface Command {
  name: string;
  description: string;
  roles: UserRole[];
  accessibility: Accessibility[];
  argsUsage?: string;
  exampleUsage?: string;
  validate?: (args: string[]) => { isValid: boolean; error?: string };
  authorize?: (role: UserRole, args: string[]) => boolean;
}

export const COMMANDS: Record<string, Command> = {
  help: {
    name: 'help',
    description: 'Displays the command guide customized to your role',
    roles: ['teacher', 'student'],
    accessibility: ['group', 'private'],
    exampleUsage: '/help'
  },
  invite: {
    name: 'invite',
    description: 'Registers a new teacher or student and sends onboarding instructions',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    argsUsage: 'student|teacher <phone> <name>',
    exampleUsage: '/invite student 60123456789 John Doe',
    validate: (args) => {
      if (args.length < 3) return { isValid: false, error: 'Usage: `/invite student|teacher <phone> <name>`' };
      const role = args[0].toLowerCase();
      if (role !== 'student' && role !== 'teacher') return { isValid: false, error: 'First argument must be "student" or "teacher".' };
      return { isValid: true };
    }
  },
  add: {
    name: 'add',
    description: 'Enrolls an existing student in a class workshop',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    argsUsage: '<phone> <subject>',
    exampleUsage: '/add 60123456789 SPM Physics',
    validate: (args) => {
      if (args.length < 2) return { isValid: false, error: 'Usage: `/add <phone> <subject>`' };
      return { isValid: true };
    }
  },
  profile: {
    name: 'profile',
    description: 'Updates a student\'s name or LearnDash User ID',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    argsUsage: '<phone> name|id <value>',
    exampleUsage: '/profile 60123456789 id 12345',
    validate: (args) => {
      if (args.length < 3) return { isValid: false, error: 'Usage: `/profile <phone> name|id <value>`' };
      const field = args[1].toLowerCase();
      if (field !== 'name' && field !== 'id') return { isValid: false, error: 'Field must be "name" or "id".' };
      return { isValid: true };
    }
  },
  groups: {
    name: 'groups',
    description: 'Lists all WhatsApp groups the bot is participating in',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    exampleUsage: '/groups'
  },
  homework: {
    name: 'homework',
    description: 'Teacher: assigns lessons. Student: lists pending (`/homework`) or marks complete (`/homework done`).',
    roles: ['teacher', 'student'],
    accessibility: ['group', 'private'],
    argsUsage: 'Teacher: <lesson_id | keyword_query> [due_date] | Student: check|done',
    exampleUsage: 'Teacher: /homework 9999\nTeacher: /homework SPM Physics 16.1 due tomorrow\nStudent: /homework check',
    authorize: (role, args) => {
      if (role === 'teacher') return true;
      // Students are only authorized to check homework (no args or 'check') or mark it completed ('done')
      return args.length === 0 || args[0].toLowerCase() === 'check' || args[0].toLowerCase() === 'done';
    },
    validate: (args) => {
      return { isValid: true };
    }
  },
  meeting: {
    name: 'meeting',
    description: 'Displays or updates the class meeting link',
    roles: ['teacher', 'student'],
    accessibility: ['group', 'private'],
    argsUsage: 'Teacher: [create] [<class_subject>] [<link>] | Student: no args',
    exampleUsage: 'Teacher: /meeting\nTeacher: /meeting create SPM Physics https://meet.google.com/abc-defg-hij\nStudent: /meeting',
    authorize: (role, args) => {
      if (role === 'teacher') return true;
      return args.length === 0;
    }
  },
  link: {
    name: 'link',
    description: 'Displays linking instructions or directly links your WordPress LearnDash User ID',
    roles: ['teacher', 'student'],
    accessibility: ['group', 'private'],
    argsUsage: '[<learndash_id>]',
    exampleUsage: '/link\n/link 12345'
  },
  unlink: {
    name: 'unlink',
    description: 'Unlinks a WordPress LearnDash User ID from a phone number',
    roles: ['teacher', 'student'],
    accessibility: ['group', 'private'],
    argsUsage: 'Teacher: <phone> | Student: no args',
    exampleUsage: 'Teacher: /unlink 60123456789\nStudent: /unlink',
    validate: (args) => {
      return { isValid: true };
    }
  },
  remove: {
    name: 'remove',
    description: 'Deletes a student/teacher globally or unenrolls a student from a workshop',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    argsUsage: 'student|teacher <phone> [<subject>]',
    exampleUsage: '/remove student 60123456789\n/remove student 60123456789 SPM Physics\n/remove teacher 60123456789',
    validate: (args) => {
      if (args.length < 2) return { isValid: false, error: 'Usage: `/remove student|teacher <phone> [<subject>]`' };
      const type = args[0].toLowerCase();
      if (type !== 'student' && type !== 'teacher') return { isValid: false, error: 'First argument must be "student" or "teacher".' };
      return { isValid: true };
    }
  },
  report: {
    name: 'report',
    description: 'Compiles and sends the progress report to your private DM',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    argsUsage: '[<group_name>] [<phone_number>]',
    exampleUsage: '/report\n/report SPM Physics\n/report 60123456789\n/report SPM Physics 60123456789'
  },
  class: {
    name: 'class',
    description: 'Teacher CRUD operations on classes/workshops',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    argsUsage: 'list | create <subject> <courseId> <day> <time> <teacher_phone> <teacher_name> | delete <subject_or_id>',
    exampleUsage: '/class list\n/class create SPM Physics 101 Monday 20:00 60123456789 John Doe\n/class delete SPM Physics',
    validate: (args) => {
      if (args.length === 0) {
        return { isValid: false, error: 'Usage: `/class list` or `/class create ...` or `/class delete ...`' };
      }
      const subAction = args[0].toLowerCase();
      if (subAction !== 'list' && subAction !== 'create' && subAction !== 'delete' && subAction !== 'archive') {
        return { isValid: false, error: 'Invalid sub-command. Use `list`, `create`, or `delete`.' };
      }
      if (subAction === 'create') {
        if (args.length < 7) {
          return { isValid: false, error: 'Usage: `/class create <subject> <courseId> <day> <time> <teacher_phone> <teacher_name>`' };
        }
      }
      if ((subAction === 'delete' || subAction === 'archive') && args.length < 2) {
        return { isValid: false, error: 'Usage: `/class delete <subject_or_id>`' };
      }
      return { isValid: true };
    }
  },
  students: {
    name: 'students',
    description: 'Lists all students enrolled in the class',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    exampleUsage: '/students'
  },
  check: {
    name: 'check',
    description: 'Checks progress of a specific student by name',
    roles: ['teacher'],
    accessibility: ['group', 'private'],
    argsUsage: '<student_name>',
    exampleUsage: '/check John',
    validate: (args) => {
      if (args.length === 0) return { isValid: false, error: 'Usage: `/check <student_name>`' };
      return { isValid: true };
    }
  }
};
