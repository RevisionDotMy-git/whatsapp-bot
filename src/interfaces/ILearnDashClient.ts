export interface CourseProgressResponse {
  courseId: number;
  userId: number;
  completedSteps: number;
  totalSteps: number;
  percentageCompleted: number;
  status: 'not_started' | 'in_progress' | 'completed';
  // List of step completions to detect skipped exercises
  completedStepsList: {
    id: number;
    type: string; // 'lesson', 'topic', 'quiz', 'assignment'
    completed: boolean;
  }[];
}

export interface AssignmentSubmissionResponse {
  assignmentId: number;
  lessonId: number;
  userId: number;
  essayText: string;
  fileUrl?: string;
  status: 'approved' | 'not_approved';
  points?: number;
  comment?: string;
}

export interface ILearnDashClient {
  /**
   * Retrieves a new JWT token using the configured credentials
   */
  authenticate(): Promise<string>;

  /**
   * Retrieves the course completion and step progress for a user
   */
  getStudentCourseProgress(userId: number, courseId: number): Promise<CourseProgressResponse>;

  /**
   * Retrieves specific text/essay assignment details submitted by a user for a lesson
   */
  getAssignmentSubmission(userId: number, lessonId: number): Promise<AssignmentSubmissionResponse | null>;

  /**
   * Programmatically submits grade and evaluation comments back to LearnDash
   */
  submitGradeAndComment(assignmentId: number, score: number, comment: string): Promise<void>;

  /**
   * Verifies if a WordPress user ID exists on the server
   */
  verifyUserId(userId: number): Promise<{ exists: boolean; error?: string }>;
}
