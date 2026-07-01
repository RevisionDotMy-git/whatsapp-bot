import { CourseProgressResponse, AssignmentSubmissionResponse } from '../../interfaces/ILearnDashClient.js';
import { CONFIG } from '../../config/constants.js';
import { logAudit } from '../../services/db.js';
import fs from 'fs';
import path from 'path';
import { categorizeCourse } from '../../utils/courseCategorizer.js';
import { ILearnDashSync, CachedCourse, CachedLesson } from './ILearnDashSync.js';

export class LearnDashSync implements ILearnDashSync {
  private jwtToken: string | null = 'BASIC_AUTH_ONLY';
  private useBasicAuth = true;
  private baseUrl = CONFIG.LEARNDASH.BASE_URL.replace(/\/+$/, '');
  
  async authenticate(): Promise<string> {
    this.useBasicAuth = true;
    this.jwtToken = 'BASIC_AUTH_ONLY';
    return this.jwtToken;
  }
 
  private async getAuthHeaders(): Promise<HeadersInit> {
    const credentials = Buffer.from(`${CONFIG.LEARNDASH.JWT_USERNAME}:${CONFIG.LEARNDASH.JWT_PASSWORD}`).toString('base64');
    return {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
  }

  async getStudentCourseProgress(userId: number, courseId: number): Promise<CourseProgressResponse> {
    const headers = await this.getAuthHeaders();
    const url = `${this.baseUrl}/wp-json/ldlms/v2/users/${userId}/courses/${courseId}/progress`;

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch student progress: status ${response.status}`);
      }

      const data = await response.json() as CourseProgressResponse;
      return data;
    } catch (err: any) {
      await logAudit('ERROR', 'LEARNDASH_PROGRESS', `Failed fetching progress for student ID ${userId} course ID ${courseId}: ${err.message}`);
      throw err;
    }
  }

  async getAssignmentSubmission(userId: number, lessonId: number): Promise<AssignmentSubmissionResponse | null> {
    const headers = await this.getAuthHeaders();
    const url = `${this.baseUrl}/wp-json/ldlms/v2/sfwd-assignment?user=${userId}&post=${lessonId}`;

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch assignments: status ${response.status}`);
      }

      const data = await response.json() as AssignmentSubmissionResponse[];
      if (data && data.length > 0) {
        return data[0];
      }
      return null;
    } catch (err: any) {
      await logAudit('ERROR', 'LEARNDASH_ASSIGNMENT', `Failed fetching assignments for user ${userId} lesson ${lessonId}: ${err.message}`);
      throw err;
    }
  }

  async submitGradeAndComment(assignmentId: number, score: number, comment: string): Promise<void> {
    const headers = await this.getAuthHeaders();
    const url = `${this.baseUrl}/wp-json/ldlms/v2/sfwd-assignment/${assignmentId}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          status: 'approved',
          points: score,
          comment: comment,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to submit grade: status ${response.status}`);
      }

      await logAudit('INFO', 'LEARNDASH_GRADE_SUBMISSION', `Successfully graded assignment ID ${assignmentId} with score ${score}.`);
    } catch (err: any) {
      await logAudit('ERROR', 'LEARNDASH_GRADE_SUBMISSION', `Failed submitting grade for assignment ID ${assignmentId}: ${err.message}`);
      throw err;
    }
  }

  async verifyUserId(userId: number): Promise<{ exists: boolean; error?: string }> {
    try {
      const headers = await this.getAuthHeaders();
      const url = `${this.baseUrl}/wp-json/wp/v2/users/${userId}`;

      const response = await fetch(url, { headers });
      if (response.status === 200) {
        return { exists: true };
      } else if (response.status === 404) {
        return { exists: false };
      } else {
        return { exists: false, error: `WordPress server returned status: ${response.status}` };
      }
    } catch (err: any) {
      await logAudit('ERROR', 'LEARNDASH_USER_VERIFICATION_FAIL', `Failed to verify user ID ${userId}: ${err.message}`);
      return { exists: false, error: err.message || 'Unknown network error' };
    }
  }

  isCacheAvailable(): boolean {
    const cacheFilePath = path.join(process.cwd(), 'data', 'learndash_cache.json');
    return fs.existsSync(cacheFilePath);
  }

  getCachedData(): CachedCourse[] {
    const cacheFilePath = path.join(process.cwd(), 'data', 'learndash_cache.json');
    if (!fs.existsSync(cacheFilePath)) {
      return [
        {
          courseId: 101,
          courseName: 'SPM Physics Complete Masterclass',
          courseLessonsCount: 3,
          courseLearndashHyperlink: 'https://course.revision.my/courses/spm-physics/',
          category: ['Physics', 'English'],
          lessons: [
            { lessonId: 1, lessonName: 'Lesson 1: Introduction to Waves & Amplitude', lessonLearndashHyperlink: '' },
            { lessonId: 2, lessonName: 'Lesson 2: Reflection and Refraction of Light', lessonLearndashHyperlink: '' },
            { lessonId: 3, lessonName: 'Lesson 3: Electromagnetism & Faraday\'s Law', lessonLearndashHyperlink: '' }
          ]
        },
        {
          courseId: 102,
          courseName: 'SPM Chemistry Intensive Revision',
          courseLessonsCount: 3,
          courseLearndashHyperlink: 'https://course.revision.my/courses/spm-chemistry/',
          category: ['Chemistry', 'English'],
          lessons: [
            { lessonId: 4, lessonName: 'Lesson 1: Acid, Base and Salt Properties', lessonLearndashHyperlink: '' },
            { lessonId: 5, lessonName: 'Lesson 2: Redox Reactions & Electrolysis', lessonLearndashHyperlink: '' },
            { lessonId: 6, lessonName: 'Lesson 3: Chemical Formulae and Equations', lessonLearndashHyperlink: '' }
          ]
        },
        {
          courseId: 103,
          courseName: 'SPM Courses Bundle',
          courseLessonsCount: 1,
          courseLearndashHyperlink: 'https://course.revision.my/courses/spm-courses/',
          category: [],
          lessons: [
            { lessonId: 7, lessonName: 'Lesson 1: Core Study Skills & Exam Strategy', lessonLearndashHyperlink: '' }
          ]
        }
      ];
    }
    
    try {
      const fileContent = fs.readFileSync(cacheFilePath, 'utf-8');
      return JSON.parse(fileContent) as CachedCourse[];
    } catch (err: any) {
      return [];
    }
  }

  private async fetchAllWordPressPages(baseUrl: string, token: string): Promise<any[]> {
    let allItems: any[] = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
      const separator = baseUrl.includes('?') ? '&' : '?';
      const url = `${baseUrl}${separator}per_page=100&page=${page}`;

      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };

      if (this.useBasicAuth) {
        const credentials = Buffer.from(`${CONFIG.LEARNDASH.JWT_USERNAME}:${CONFIG.LEARNDASH.JWT_PASSWORD}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
      } else {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(url, { headers });

      if (!response.ok) {
        if (page === 1) {
          throw new Error(`WordPress API returned status ${response.status}`);
        }
        break;
      }

      const items = await response.json();
      if (!Array.isArray(items) || items.length === 0) {
        hasNext = false;
      } else {
        allItems = allItems.concat(items);
        if (items.length < 100) {
          hasNext = false;
        } else {
          page++;
        }
      }
    }
    return allItems;
  }

  categorizeCourse(title: string): string[] {
    return categorizeCourse(title);
  }

  async syncAllWithLearnDash(): Promise<CachedCourse[]> {
    try {
      const token = await this.authenticate();
      const coursesUrl = `${this.baseUrl}/wp-json/ldlms/v2/sfwd-courses`;
      const coursesRaw = await this.fetchAllWordPressPages(coursesUrl, token);
      
      await logAudit('INFO', 'LEARNDASH_SYNC_START', `Starting cache sync for ${coursesRaw.length} courses in parallel.`);
      
      const cachedCourses: CachedCourse[] = await Promise.all(
        coursesRaw.map(async (course: any) => {
          const courseId = course.id;
          const courseName = course.title?.rendered || `Course ${courseId}`;
          const courseLearndashHyperlink = course.link || '';
          const category = this.categorizeCourse(courseName);
          
          const lessonsUrl = `${this.baseUrl}/wp-json/ldlms/v2/sfwd-lessons?course=${courseId}`;
          let lessonsRaw: any[] = [];
          try {
            lessonsRaw = await this.fetchAllWordPressPages(lessonsUrl, token);
          } catch (lessonErr: any) {
            await logAudit('WARN', 'LEARNDASH_SYNC_LESSONS_FAIL', `Failed fetching lessons for course ${courseId}: ${lessonErr.message}`);
          }
          
          const lessons: CachedLesson[] = lessonsRaw.map((lesson: any) => ({
            lessonId: lesson.id,
            lessonName: lesson.title?.rendered || `Lesson ${lesson.id}`,
            lessonLearndashHyperlink: lesson.link || ''
          }));
          
          return {
            courseId,
            courseName,
            courseLessonsCount: lessons.length,
            courseLearndashHyperlink,
            category,
            lessons
          };
        })
      );
      
      const dirPath = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      
      const cacheFilePath = path.join(dirPath, 'learndash_cache.json');
      fs.writeFileSync(cacheFilePath, JSON.stringify(cachedCourses, null, 2), 'utf-8');
      
      await logAudit('INFO', 'LEARNDASH_CACHE_SYNC', `Successfully synchronized ${cachedCourses.length} courses and their lessons to local cache.`);
      
      return cachedCourses;
    } catch (err: any) {
      await logAudit('ERROR', 'LEARNDASH_CACHE_SYNC_FAIL', `LearnDash cache sync failed: ${err.message}`);
      throw err;
    }
  }
}
