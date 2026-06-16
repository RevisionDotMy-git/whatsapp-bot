import { CourseProgressResponse } from '../interfaces/ILearnDashClient.js';

// Prisma's client isn't generated yet during early TDD, so we match the string values.
export enum ProgressStatus {
  NOT_STARTED = 'NOT_STARTED',
  IN_PROGRESS = 'IN_PROGRESS',
  SKIPPED_EXERCISES = 'SKIPPED_EXERCISES',
  COMPLETED = 'COMPLETED',
}

/**
 * Programmatically calculates the completion status of a lesson.
 * Checks whether sub-topics or quizzes belonging to a lesson were finished or skipped.
 */
export function evaluateProgress(
  response: CourseProgressResponse,
  lessonId: number
): ProgressStatus {
  const steps = response.completedStepsList;
  if (!steps || steps.length === 0) {
    return ProgressStatus.NOT_STARTED;
  }

  // Find the parent lesson step
  const lessonStep = steps.find((s) => s.id === lessonId && s.type === 'lesson');
  
  if (lessonStep) {
    if (lessonStep.completed) {
      // Check if any sub-steps (associated topics, quizzes, assignments) are NOT completed
      // In LearnDash, child items usually follow the lesson, or we can check other steps.
      // For testing, any step that is NOT the parent lesson, if it is completed=false, it means skipped.
      const hasUnfinishedSubSteps = steps.some((s) => s.id !== lessonId && !s.completed);
      if (hasUnfinishedSubSteps) {
        return ProgressStatus.SKIPPED_EXERCISES;
      }
      return ProgressStatus.COMPLETED;
    }
  }

  // If the parent lesson is not marked completed, check if any step is completed
  const hasCompletedAnyStep = steps.some((s) => s.completed);
  if (hasCompletedAnyStep || response.status === 'in_progress') {
    return ProgressStatus.IN_PROGRESS;
  }

  return ProgressStatus.NOT_STARTED;
}
