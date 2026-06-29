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

export interface ParsedDueDate {
  date: Date;
  reason: string;
}

/**
 * Strictly parses a due date from a text string.
 * This version uses anchored regexes to ensure the string is exactly the due date.
 */
export function parseDueDateStrict(text: string): ParsedDueDate | null {
  const textLower = text.toLowerCase().trim();
  
  const tomorrowMatch = textLower.match(/^(?:this homework due|due|by|before)?\s*tomorrow$/i);
  const nextWeekMatch = textLower.match(/^(?:this homework due|due|by|before)?\s*next\s*[-]?\s*week$/i);
  const nextMonthMatch = textLower.match(/^(?:this homework due|due|by|before)?\s*next\s*[-]?\s*month$/i);
  const relativeMatch = textLower.match(/^(?:this homework due|due|by|before)\s+(\d+)\s+days?$/i);
  const dateMatch = textLower.match(/^(?:complete\s+it\s+before|before|due|by)\s+(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?$/i);
  
  const nextWeekNoSpaceMatch = textLower.match(/^(?:this homework due|due|by|before)?\s*nextweek$/i);
  const nextMonthNoSpaceMatch = textLower.match(/^(?:this homework due|due|by|before)?\s*nextmonth$/i);

  if (tomorrowMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return { date: d, reason: 'tomorrow' };
  } else if (nextWeekMatch || nextWeekNoSpaceMatch) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return { date: d, reason: 'next week' };
  } else if (nextMonthMatch || nextMonthNoSpaceMatch) {
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

