import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveLessonsFromText } from '../utils/naturalLanguageParser.js';
import fs from 'fs';

describe('Natural Language Homework Assignment Parser', () => {
  let existsSpy: any;
  let readSpy: any;

  beforeEach(() => {
    existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify([
      {
        courseId: 101,
        courseName: "Form 5 Chemistry",
        category: ["Chemistry", "English", "Form_5"],
        lessons: [
          {
            lessonId: 1001,
            lessonName: "16.1 Organisation of Plant Tissues",
            lessonLearndashHyperlink: "https://example.com/chem-16-1"
          }
        ]
      },
      {
        courseId: 102,
        courseName: "Form 5 Biology",
        category: ["Biology", "English", "Form_5"],
        lessons: [
          {
            lessonId: 1002,
            lessonName: "16.1 Plant Hormones",
            lessonLearndashHyperlink: "https://example.com/bio-16-1"
          }
        ]
      },
      {
        courseId: 103,
        courseName: "Form 4 Physics",
        category: ["Physics", "English", "Form_4"],
        lessons: [
          {
            lessonId: 1003,
            lessonName: "1.1 Physical Quantities",
            lessonLearndashHyperlink: "https://example.com/phy-1-1"
          },
          {
            lessonId: 1004,
            lessonName: "1.2 Scientific Investigation",
            lessonLearndashHyperlink: "https://example.com/phy-1-2"
          }
        ]
      }
    ]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve a single lesson from text', () => {
    const res = resolveLessonsFromText(
      "please complete form 5 chemistry 16.1 by next week",
      "mock_cache.json"
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual({
      courseId: 101,
      lessonId: 1001,
      lessonName: "16.1 Organisation of Plant Tissues",
      hyperlink: "https://example.com/chem-16-1",
      courseName: "Form 5 Chemistry"
    });
  });

  it('should resolve multiple lessons spanning multiple subjects with level inheritance', () => {
    const res = resolveLessonsFromText(
      "please complete form 5 chemistry 16.1 and biology 16.1 before next week",
      "mock_cache.json"
    );
    expect(res).toHaveLength(2);
    expect(res[0].lessonId).toBe(1001); // Chem
    expect(res[1].lessonId).toBe(1002); // Bio
  });

  it('should resolve multiple lessons in the same subject with subject and level inheritance', () => {
    const res = resolveLessonsFromText(
      "please complete form 4 physics 1.1 and 1.2 by tomorrow",
      "mock_cache.json"
    );
    expect(res).toHaveLength(2);
    expect(res[0].lessonId).toBe(1003); // Phys 1.1
    expect(res[1].lessonId).toBe(1004); // Phys 1.2
  });

  it('should return empty list when no lessons match', () => {
    const res = resolveLessonsFromText(
      "please complete form 5 chemistry 99.9",
      "mock_cache.json"
    );
    expect(res).toHaveLength(0);
  });
});
