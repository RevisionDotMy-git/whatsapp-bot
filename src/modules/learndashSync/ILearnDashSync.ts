import { CourseProgressResponse, AssignmentSubmissionResponse } from '../../interfaces/ILearnDashClient.js';

export interface CachedLesson {
  lessonId: number;
  lessonName: string;
  lessonLearndashHyperlink: string;
}

export interface CachedCourse {
  courseId: number;
  courseName: string;
  courseLessonsCount: number;
  courseLearndashHyperlink: string;
  category: string[];
  lessons: CachedLesson[];
}

export interface ILearnDashSync {
  getStudentCourseProgress(userId: number, courseId: number): Promise<CourseProgressResponse>;
  getAssignmentSubmission(userId: number, lessonId: number): Promise<AssignmentSubmissionResponse | null>;
  submitGradeAndComment(assignmentId: number, score: number, comment: string): Promise<void>;
  verifyUserId(userId: number): Promise<{ exists: boolean; error?: string }>;
  isCacheAvailable(): boolean;
  getCachedData(): CachedCourse[];
  categorizeCourse(title: string): string[];
  syncAllWithLearnDash(): Promise<CachedCourse[]>;
}
