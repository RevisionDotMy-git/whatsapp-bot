export interface CommandResult {
  command: string;
  lessonId: number | null;
  role: 'teacher' | 'student' | 'unknown';
  isAuthorized: boolean;
  dueDate: Date | null;
}

/**
 * Parses incoming WhatsApp messages to identify commands, check authorization, and calculate expiry.
 */
export function parseCommand(
  text: string,
  senderJid: string,
  teacherJid: string,
  studentJids: string[]
): CommandResult | null {
  const trimmed = text.trim();
  
  // Verify if it is a command (starts with / or @bot)
  const isCommand = trimmed.startsWith('/') || trimmed.toLowerCase().startsWith('@bot ');
  if (!isCommand) {
    return null;
  }

  // Extract command name and arguments
  let commandBody = trimmed;
  if (trimmed.toLowerCase().startsWith('@bot ')) {
    commandBody = trimmed.substring(5).trim();
  } else if (trimmed.startsWith('/')) {
    commandBody = trimmed.substring(1).trim();
  }

  const parts = commandBody.split(/\s+/);
  const commandName = parts[0].toLowerCase();
  const args = parts.slice(1);

  const recognizedCommands = ['homework', 'meeting', 'link', 'report', 'students', 'check', 'groups', 'invite', 'add', 'profile', 'help'];
  if (!recognizedCommands.includes(commandName)) {
    return null;
  }

  // Identify role
  let role: 'teacher' | 'student' | 'unknown' = 'unknown';
  if (senderJid === teacherJid) {
    role = 'teacher';
  } else if (studentJids.includes(senderJid)) {
    role = 'student';
  }

  // Determine authorized commands per role
  const studentAllowedCommands = ['meeting', 'link', 'homework', 'help'];

  let isAuthorized = false;
  if (role === 'teacher') {
    // Teacher is authorized to run any recognized command
    isAuthorized = true;
  } else if (role === 'student') {
    if (commandName === 'homework') {
      // Students are only authorized to check the homework list (no arguments)
      isAuthorized = args.length === 0;
    } else if (studentAllowedCommands.includes(commandName)) {
      isAuthorized = true;
    }
  }

  // Specific command: homework
  let lessonId: number | null = null;
  let dueDate: Date | null = null;

  if (commandName === 'homework') {
    const rawId = args[0];
    if (rawId) {
      const parsedId = parseInt(rawId, 10);
      if (!isNaN(parsedId)) {
        lessonId = parsedId;
      }
      
      // Automatically set due date to 7 days from now only when assigning homework
      const now = new Date();
      dueDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
  }

  return {
    command: commandName,
    lessonId,
    role,
    isAuthorized,
    dueDate,
  };
}
