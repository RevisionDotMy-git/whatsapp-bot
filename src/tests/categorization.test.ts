import { describe, it, expect } from 'vitest';
import { LearnDashService } from '../services/LearnDashService.js';

describe('LearnDash Course Categorization', () => {
  const service = new LearnDashService();

  it('should categorize Biologi Tingkatan 4 correctly', () => {
    const cats = service.categorizeCourse('Biologi Tingkatan 4');
    expect(cats).toContain('Biology');
    expect(cats).toContain('Malay');
    expect(cats).toContain('Form_4');
  });

  it('should categorize SPM Physics Complete Masterclass Form 5 correctly', () => {
    const cats = service.categorizeCourse('SPM Physics Complete Masterclass Form 5');
    expect(cats).toContain('Physics');
    expect(cats).toContain('English');
    expect(cats).toContain('Form_5');
  });

  it('should categorize Matematik Tambahan T4 correctly', () => {
    const cats = service.categorizeCourse('Matematik Tambahan T4');
    expect(cats).toContain('Additional Mathematics');
    expect(cats).toContain('Malay');
    expect(cats).toContain('Form_4');
  });

  it('should categorize Chemistry F5 correctly', () => {
    const cats = service.categorizeCourse('Chemistry F5');
    expect(cats).toContain('Chemistry');
    expect(cats).toContain('English');
    expect(cats).toContain('Form_5');
  });
});
