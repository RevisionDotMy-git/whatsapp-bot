export interface ParsedDueDate {
  date: Date;
  reason: string;
}

/**
 * Strictly parses a due date from a text string (anchored regexes).
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
 * Parses relative due dates leniently from substring matches (used in custom homework caption overrides).
 */
export function parseDueDate(text: string | null | undefined): ParsedDueDate | null {
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
