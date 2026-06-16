import { describe, it, expect } from 'vitest';
import { evaluateProgress, ProgressStatus } from '../utils/progressEvaluator.js';
import { CourseProgressResponse } from '../interfaces/ILearnDashClient.js';

describe('Progress Evaluator', () => {
  const lessonId = 101;

  it('should return COMPLETED when all sub-steps of the lesson are completed', () => {
    const mockResponse: CourseProgressResponse = {
      courseId: 50,
      userId: 12,
      completedSteps: 3,
      totalSteps: 3,
      percentageCompleted: 100,
      status: 'completed',
      completedStepsList: [
        { id: 101, type: 'lesson', completed: true },
        { id: 201, type: 'topic', completed: true },
        { id: 301, type: 'quiz', completed: true }
      ]
    };

    const status = evaluateProgress(mockResponse, lessonId);
    expect(status).toBe(ProgressStatus.COMPLETED);
  });

  it('should return SKIPPED_EXERCISES when the lesson is marked completed but sub-steps are false', () => {
    const mockResponse: CourseProgressResponse = {
      courseId: 50,
      userId: 12,
      completedSteps: 1,
      totalSteps: 3,
      percentageCompleted: 33,
      status: 'in_progress',
      completedStepsList: [
        { id: 101, type: 'lesson', completed: true }, // Parent is completed
        { id: 201, type: 'topic', completed: false }, // But child topic is skipped
        { id: 301, type: 'quiz', completed: false }
      ]
    };

    const status = evaluateProgress(mockResponse, lessonId);
    expect(status).toBe(ProgressStatus.SKIPPED_EXERCISES);
  });

  it('should return IN_PROGRESS when progress is underway but parent lesson is not completed', () => {
    const mockResponse: CourseProgressResponse = {
      courseId: 50,
      userId: 12,
      completedSteps: 1,
      totalSteps: 3,
      percentageCompleted: 33,
      status: 'in_progress',
      completedStepsList: [
        { id: 101, type: 'lesson', completed: false },
        { id: 201, type: 'topic', completed: true },
        { id: 301, type: 'quiz', completed: false }
      ]
    };

    const status = evaluateProgress(mockResponse, lessonId);
    expect(status).toBe(ProgressStatus.IN_PROGRESS);
  });

  it('should return NOT_STARTED when zero steps are completed', () => {
    const mockResponse: CourseProgressResponse = {
      courseId: 50,
      userId: 12,
      completedSteps: 0,
      totalSteps: 3,
      percentageCompleted: 0,
      status: 'not_started',
      completedStepsList: [
        { id: 101, type: 'lesson', completed: false },
        { id: 201, type: 'topic', completed: false },
        { id: 301, type: 'quiz', completed: false }
      ]
    };

    const status = evaluateProgress(mockResponse, lessonId);
    expect(status).toBe(ProgressStatus.NOT_STARTED);
  });
});
