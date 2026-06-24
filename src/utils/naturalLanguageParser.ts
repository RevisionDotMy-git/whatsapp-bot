import fs from 'fs';
import { categorizeCourse } from './courseCategorizer.js';

export interface ResolvedLesson {
  courseId: number;
  lessonId: number;
  lessonName: string;
  hyperlink: string;
  courseName: string;
}

/**
 * Parses natural language message text to resolve one or more LearnDash lessons from the cache.
 */
export function resolveLessonsFromText(text: string, cachePath: string): ResolvedLesson[] {
  const textLower = text.toLowerCase().trim();
  
  // 1. Extract default Level/Form (e.g. Form 4 or Form 5) from the entire message
  const levelMatch = text.match(/(?:tingkatan|form)\s*([1-5])/i) || text.match(/\b[tf]([1-5])\b/i);
  const defaultLevel = levelMatch ? `Form_${levelMatch[1]}` : null;

  // 2. Split the message by common sentence splitters (e.g. "and", "also", ",", "&", "then")
  // to process each segment independently.
  const segments = text.split(/\band\b|\balso\b|\bthen\b|[,&]/i);
  const resolved: ResolvedLesson[] = [];
  
  // Keep track of the last successfully detected subject and form to support inheritance
  // e.g. "please complete form 5 chemistry 16.1 and biology 16.1" -> biology inherits Form 5
  // e.g. "please complete form 4 chemistry 1.1 and 1.2" -> 1.2 inherits Form 4 and Chemistry
  let activeLevel = defaultLevel;
  let activeSubject = '';

  // Read LearnDash Cache
  let cache: any[] = [];
  try {
    if (fs.existsSync(cachePath)) {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    }
  } catch (err) {
    console.error('Failed to read LearnDash cache for natural language parsing:', err);
    return [];
  }

  for (const segment of segments) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) continue;

    // Use courseCategorizer to extract subject and form categories in this segment
    const segmentCategories = categorizeCourse(trimmedSegment);
    
    // Extract level from segment (if present), else fallback to activeLevel
    const levelCategory = segmentCategories.find(c => c.startsWith('Form_')) || activeLevel;
    if (levelCategory) {
      activeLevel = levelCategory;
    }

    // Extract subject from segment (if present), else fallback to activeSubject
    // Avoid Language categories (Malay, English) when selecting subject
    const subjectCategory = segmentCategories.find(c => 
      c !== 'Malay' && c !== 'English' && !c.startsWith('Form_')
    ) || activeSubject;
    
    if (subjectCategory) {
      activeSubject = subjectCategory;
    }

    // Extract lesson number (e.g. 16.1 or 16-1 or 1.2) from the segment
    const lessonMatch = trimmedSegment.match(/(\d{1,2})[-.](\d{1,2})/);
    if (!lessonMatch) continue;

    const lessonPrefix = `${lessonMatch[1]}.${lessonMatch[2]}`;
    const lessonPrefixAlt = `${lessonMatch[1]}-${lessonMatch[2]}`;

    if (!activeLevel || !activeSubject) continue;

    // Find the matching course in cache
    const course = cache.find(c => 
      c.category.includes(activeLevel) && 
      c.category.includes(activeSubject)
    );
    if (!course) continue;

    // Find matching lesson
    const lesson = course.lessons.find((l: any) => 
      l.lessonName.startsWith(lessonPrefix) || 
      l.lessonName.startsWith(lessonPrefixAlt) ||
      l.lessonName.includes(` ${lessonPrefix} `) ||
      l.lessonName.includes(` ${lessonPrefixAlt} `)
    );

    if (lesson) {
      // Avoid duplicate resolutions of the same lesson ID
      if (!resolved.some(r => r.lessonId === lesson.lessonId)) {
        resolved.push({
          courseId: course.courseId,
          lessonId: lesson.lessonId,
          lessonName: lesson.lessonName,
          hyperlink: lesson.lessonLearndashHyperlink,
          courseName: course.courseName
        });
      }
    }
  }

  return resolved;
}
