export interface ParsedStudentRow {
  name: string;      // Formatted as form[level]-[name] if level is present
  originalName: string;
  phone: string;     // Cleaned (digits only, e.g. "60123456789")
  groupNames: string[]; // The list of group / workshop names (e.g. ["SPM Physics", "SPM Courses"])
  level: string;     // Level value if present (e.g. "5")
  isValid: boolean;  // True if the row passed formatting validation
  error?: string;    // Validation error details if invalid
}

/**
 * Splits a CSV line taking quotes into account to allow commas inside quoted values.
 */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' || char === "'") {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result.map(col => col.replace(/^["']|["']$/g, '').trim());
}

/**
 * Parses a CSV string to extract students and their target groups.
 * Formats names as `form[level]-[name]` (e.g. `form5-John Doe`) if `level` is present.
 */
export function parseCsvString(csvText: string): ParsedStudentRow[] {
  const lines = csvText.split(/\r?\n/);
  if (lines.length <= 1) return [];

  // Parse headers to find indexes (case-insensitive, trimmed, and spaces removed)
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, '').replace(/\s+/g, ''));
  
  // Header aliases mapping
  const nameIdx = headers.findIndex(h => ['name', 'fullname', 'studentname', 'student'].includes(h));
  const phoneIdx = headers.findIndex(h => ['phone', 'phonenumber', 'telephone', 'mobile', 'jid'].includes(h));
  const groupIdx = headers.findIndex(h => ['group', 'class', 'subject', 'workshop'].includes(h));
  const levelIdx = headers.findIndex(h => ['level', 'form', 'grade', 'year'].includes(h));

  if (nameIdx === -1 || phoneIdx === -1 || groupIdx === -1) {
    throw new Error('CSV must contain headers for name, phone, and group');
  }

  const results: ParsedStudentRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = splitCsvLine(line);
    if (cols.length < Math.max(nameIdx, phoneIdx, groupIdx) + 1) continue;

    const originalName = cols[nameIdx];
    let phone = cols[phoneIdx].replace(/\D/g, ''); // Keep only digits
    const rawGroup = cols[groupIdx];
    const levelVal = levelIdx !== -1 && cols[levelIdx] ? cols[levelIdx].trim() : '';

    if (!originalName || !phone || !rawGroup) continue;

    // Standardize Malaysian phone numbers
    if (phone.startsWith('0')) {
      phone = '60' + phone.substring(1);
    }

    // Validation: check phone length
    const isValidPhone = phone.length >= 10 && phone.length <= 15;
    let rowError: string | undefined;
    if (!isValidPhone) {
      rowError = `Invalid phone number: "${phone}" (must be 10-15 digits after prefixing)`;
    }

    // Split groupNames if comma-separated
    const groupNames = rawGroup.split(',').map(g => g.trim()).filter(g => g.length > 0);

    // Nickname formatting logic: form[level]-[name]
    let formattedName = originalName;
    if (levelVal) {
      const cleanedLevel = levelVal.toLowerCase().replace(/\s+/g, '');
      let prefix = cleanedLevel;
      if (/^\d+$/.test(cleanedLevel)) {
        prefix = `form${cleanedLevel}`;
      } else if (cleanedLevel.startsWith('f') && /^\d+$/.test(cleanedLevel.substring(1))) {
        prefix = `form${cleanedLevel.substring(1)}`;
      }
      formattedName = `${prefix}-${originalName}`;
    }

    results.push({
      name: formattedName,
      originalName,
      phone,
      groupNames,
      level: levelVal,
      isValid: !rowError,
      error: rowError,
    });
  }
  
  return results;
}
