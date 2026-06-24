/**
 * Categorizes a course or text title into subject, language, and level metadata.
 */
export function categorizeCourse(title: string): string[] {
  const categories: string[] = [];
  const normalizedTitle = title.toLowerCase();

  // 1. Detect Subject (checking Add Maths first to prevent prefix match)
  if (normalizedTitle.includes('matematik tambahan') || normalizedTitle.includes('add maths') || normalizedTitle.includes('add math') || normalizedTitle.includes('additional mathematics') || normalizedTitle.includes('addmath')) {
    categories.push('Additional Mathematics');
  } else if (normalizedTitle.includes('matematik') || normalizedTitle.includes('mathematics') || normalizedTitle.includes('maths') || normalizedTitle.includes('math')) {
    categories.push('Mathematics');
  }

  if (normalizedTitle.includes('biologi') || normalizedTitle.includes('biology') || normalizedTitle.includes('bio')) {
    categories.push('Biology');
  }
  if (normalizedTitle.includes('fizik') || normalizedTitle.includes('physics') || normalizedTitle.includes('phy')) {
    categories.push('Physics');
  }
  if (normalizedTitle.includes('kimia') || normalizedTitle.includes('chemistry') || normalizedTitle.includes('chem')) {
    categories.push('Chemistry');
  }
  if (normalizedTitle.includes('sains') || normalizedTitle.includes('science')) {
    categories.push('Science');
  }
  if (normalizedTitle.includes('sejarah') || normalizedTitle.includes('history')) {
    categories.push('History');
  }
  if (normalizedTitle.includes('geografi') || normalizedTitle.includes('geography')) {
    categories.push('Geography');
  }
  if (normalizedTitle.includes('bahasa melayu') || normalizedTitle.includes('bahasa malaysia') || normalizedTitle.includes(' bm ')) {
    categories.push('Malay');
  }
  if (normalizedTitle.includes('bahasa inggeris') || normalizedTitle.includes('english') || normalizedTitle.includes(' bi ')) {
    categories.push('English');
  }
  if (normalizedTitle.includes('perakaunan') || normalizedTitle.includes('accounting') || normalizedTitle.includes('accounts')) {
    categories.push('Accounting');
  }
  if (normalizedTitle.includes('ekonomi') || normalizedTitle.includes('economics')) {
    categories.push('Economics');
  }
  if (normalizedTitle.includes('perniagaan') || normalizedTitle.includes('business')) {
    categories.push('Business');
  }

  // 2. Detect Language (Medium of instruction)
  const MalayKeywords = ['tingkatan', 'biologi', 'fizik', 'kimia', 'matematik', 'tambahan', 'sains', 'sejarah', 'geografi', 'perniagaan', 'ekonomi', 'bahasa melayu', 'melayu'];
  const EnglishKeywords = ['form', 'biology', 'physics', 'chemistry', 'mathematics', 'additional', 'science', 'history', 'geography', 'business', 'economics', 'accounts', 'accounting', 'english'];
  
  let hasMalayKeyword = MalayKeywords.some(kw => normalizedTitle.includes(kw));
  let hasEnglishKeyword = EnglishKeywords.some(kw => normalizedTitle.includes(kw));

  if (categories.includes('Malay')) hasMalayKeyword = true;
  if (categories.includes('English')) hasEnglishKeyword = true;

  if (hasMalayKeyword) {
    categories.push('Malay');
  }
  if (hasEnglishKeyword) {
    categories.push('English');
  }

  const uniqueCategories = Array.from(new Set(categories));

  // 3. Detect Level/Form (e.g. Tingkatan 4, Form 5, T4, F5)
  const formMatch = normalizedTitle.match(/(?:tingkatan|form)\s*([1-5])/i);
  if (formMatch) {
    uniqueCategories.push(`Form_${formMatch[1]}`);
  } else {
    const shorthandMatch = normalizedTitle.match(/\b[tf]([1-5])\b/i);
    if (shorthandMatch) {
      uniqueCategories.push(`Form_${shorthandMatch[1]}`);
    }
  }

  return uniqueCategories;
}
