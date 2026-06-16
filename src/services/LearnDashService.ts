import { ILearnDashClient, CourseProgressResponse, AssignmentSubmissionResponse } from '../interfaces/ILearnDashClient.js';
import { CONFIG } from '../config/constants.js';
import { logAudit } from './db.js';

export class LearnDashService implements ILearnDashClient {
  private jwtToken: string | null = null;

  async authenticate(): Promise<string> {
    const url = `${CONFIG.LEARNDASH.BASE_URL}/wp-json/jwt-auth/v1/token`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: CONFIG.LEARNDASH.JWT_USERNAME,
          password: CONFIG.LEARNDASH.JWT_PASSWORD,
        }),
      });

      if (!response.ok) {
        throw new Error(`Auth failed with status ${response.status}`);
      }

      const data = (await response.json()) as { token: string };
      this.jwtToken = data.token;
      
      await logAudit('INFO', 'LEARNDASH_AUTH', 'Successfully authenticated with LearnDash REST API and retrieved JWT token.');
      return this.jwtToken;
    } catch (err: any) {
      await logAudit('ERROR', 'LEARNDASH_AUTH', `Authentication failed: ${err.message}`);
      throw err;
    }
  }

  private async getAuthHeaders(): Promise<HeadersInit> {
    if (!this.jwtToken) {
      await this.authenticate();
    }
    return {
      'Authorization': `Bearer ${this.jwtToken}`,
      'Content-Type': 'application/json',
    };
  }

  async getStudentCourseProgress(userId: number, courseId: number): Promise<CourseProgressResponse> {
    const headers = await this.getAuthHeaders();
    // Path for course progress in LearnDash
    const url = `${CONFIG.LEARNDASH.BASE_URL}/wp-json/ldlms/v2/users/${userId}/courses/${courseId}/progress`;

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
    // Retrieve assignments matching student and lesson
    const url = `${CONFIG.LEARNDASH.BASE_URL}/wp-json/ldlms/v2/sfwd-assignment?user=${userId}&post=${lessonId}`;

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch assignments: status ${response.status}`);
      }

      const data = await response.json() as AssignmentSubmissionResponse[];
      if (data && data.length > 0) {
        // Return latest submission
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
    const url = `${CONFIG.LEARNDASH.BASE_URL}/wp-json/ldlms/v2/sfwd-assignment/${assignmentId}`;

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
}
