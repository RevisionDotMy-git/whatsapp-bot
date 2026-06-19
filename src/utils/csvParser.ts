export interface ParsedStudentRow {
  name: string;      // Formatted as form[level]-[name] if level is present
  originalName: string;
  phone: string;     // Cleaned (digits only, e.g. "60123456789")
  groupName: string; // The group / workshop name (e.g. "SPM Chemistry")
  level: string;     // Level value if present (e.g. "5")
}

/**
 * Parses a CSV string to extract students and their target groups.
 * Formats names as `form[level]-[name]` (e.g. `form5-John Doe`) if `level` is present.
 */
export function parseCsvString(csvText: string): ParsedStudentRow[] {
  const lines = csvText.split(/\r?\n/);
  if (lines.length <= 1) return [];

  // Parse headers to find indexes (case-insensitive and trimmed)
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  
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

    // Split columns (handling basic CSV quotation)
    const cols = line.split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length < Math.max(nameIdx, phoneIdx, groupIdx) + 1) continue;

    const originalName = cols[nameIdx];
    const phone = cols[phoneIdx].replace(/\D/g, ''); // Keep only digits
    const groupName = cols[groupIdx];
    const levelVal = levelIdx !== -1 && cols[levelIdx] ? cols[levelIdx].trim() : '';

    if (!originalName || !phone || !groupName) continue;

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
      groupName,
      level: levelVal,
    });
  }
  
  return results;
}
