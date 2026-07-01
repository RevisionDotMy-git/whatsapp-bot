import { COMMANDS, UserRole } from './commandRegistry.js';

export interface CommandResult {
  command: string;
  lessonId: number | null;
  role: 'teacher' | 'student' | 'unknown';
  isAuthorized: boolean;
  dueDate: Date | null;
  isValid: boolean;
  validationError?: string;
  args: string[];
}

import { parseDueDateStrict, ParsedDueDate } from './dateParser.js';

/**
 * Parses incoming WhatsApp messages to identify commands, check authorization, and calculate expiry.
 */
export function parseCommand(
  text: string,
  senderJid: string,
  teacherJidOrJids: string | string[],
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
  let args = parts.slice(1);

  // Retrieve command from registry
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    return null;
  }

  // Identify role
  const teacherJids = Array.isArray(teacherJidOrJids) ? teacherJidOrJids : [teacherJidOrJids];
  let role: 'teacher' | 'student' | 'unknown' = 'unknown';
  if (teacherJids.includes(senderJid)) {
    role = 'teacher';
  } else if (studentJids.includes(senderJid)) {
    role = 'student';
  }

  // Determine authorized commands per role based on registry
  let isAuthorized = role !== 'unknown' && cmd.roles.includes(role as UserRole);
  if (isAuthorized && cmd.authorize) {
    isAuthorized = cmd.authorize(role as UserRole, args);
  }

  // Validate arguments using the registry's validate function
  let isValid = true;
  let validationError: string | undefined;
  if (cmd.validate) {
    const valRes = cmd.validate(args);
    if (!valRes.isValid) {
      isValid = false;
      validationError = valRes.error;
    }
  }

  // Specific command: homework (backward compatibility for lessonId / dueDate extraction)
  let lessonId: number | null = null;
  let dueDate: Date | null = null;

  if (commandName === 'homework') {
    const isDelete = args[0] && args[0].toLowerCase() === 'delete';
    if (isDelete) {
      const rawId = args[1];
      if (rawId) {
        const parsedId = parseInt(rawId, 10);
        if (!isNaN(parsedId)) {
          lessonId = parsedId;
        }
      }
    } else if (args.length > 0) {
      let foundDueDate: Date | null = null;
      let cutIndex = args.length;

      // Scan left-to-right (0 to args.length - 1) to find the longest matching suffix
      for (let i = 0; i < args.length; i++) {
        const suffix = args.slice(i).join(' ');
        const parsedDue = parseDueDateStrict(suffix);
        if (parsedDue) {
          foundDueDate = parsedDue.date;
          cutIndex = i;
          break;
        }
      }

      const queryArgs = args.slice(0, cutIndex);
      const queryStr = queryArgs.join(' ').trim();

      if (queryStr) {
        const parsedId = parseInt(queryStr, 10);
        if (!isNaN(parsedId) && /^\d+$/.test(queryStr)) {
          lessonId = parsedId;
        } else {
          lessonId = null; // Search query
        }
      }

      // Update args to only contain the prefix (query or lesson ID)
      args = queryArgs;

      if (foundDueDate) {
        dueDate = foundDueDate;
      } else {
        const now = new Date();
        dueDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      }
    }
  }

  return {
    command: commandName,
    lessonId,
    role,
    isAuthorized,
    dueDate,
    isValid,
    validationError,
    args,
  };
}

