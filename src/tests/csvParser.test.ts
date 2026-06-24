import { describe, it, expect } from 'vitest';
import { parseCsvString } from '../utils/csvParser.js';
import { parseCommand } from '../utils/commandParser.js';

describe('CSV Roster Parser (Perspective: Nickname formatting & data cleaning)', () => {
  it('should parse standard CSV columns correctly and extract data', () => {
    const csvContent = `name,phone,group,level\nJohn Doe,60123456789,SPM Chemistry,5\nJane Smith,60198765432,SPM Physics,4`;
    const result = parseCsvString(csvContent);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: 'form5-John Doe',
      originalName: 'John Doe',
      phone: '60123456789',
      groupNames: ['SPM Chemistry'],
      level: '5',
      isValid: true,
      error: undefined,
    });
    expect(result[1]).toEqual({
      name: 'form4-Jane Smith',
      originalName: 'Jane Smith',
      phone: '60198765432',
      groupNames: ['SPM Physics'],
      level: '4',
      isValid: true,
      error: undefined,
    });
  });

  it('should map alias headers (like fullname, phoneNumber, class)', () => {
    const csvContent = `fullname,phoneNumber,class,form\nLynxx,601110854085,SPM Biology,5`;
    const result = parseCsvString(csvContent);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'form5-Lynxx',
      originalName: 'Lynxx',
      phone: '601110854085',
      groupNames: ['SPM Biology'],
      level: '5',
      isValid: true,
      error: undefined,
    });
  });

  it('should format level values robustly (e.g. 5 -> form5, f4 -> form4)', () => {
    const csvContent = `name,phone,group,level\nStudent A,60111222333,SPM Chemistry, 5\nStudent B,60111222444,SPM Physics, f4\nStudent C,60111222555,SPM Biology, form 3`;
    const result = parseCsvString(csvContent);

    expect(result[0].name).toBe('form5-Student A');
    expect(result[1].name).toBe('form4-Student B');
    expect(result[2].name).toBe('form3-Student C');
  });

  it('should clean phone numbers of non-digit formatting characters', () => {
    const csvContent = `name,phone,group,level\nJohn Doe,+6012-345 6789,SPM Chemistry,5`;
    const result = parseCsvString(csvContent);

    expect(result[0].phone).toBe('60123456789');
  });

  it('should leave nickname unchanged if level column is missing or blank', () => {
    const csvContent = `name,phone,group\nJohn Doe,60123456789,SPM Chemistry`;
    const result = parseCsvString(csvContent);

    expect(result[0].name).toBe('John Doe');
    expect(result[0].level).toBe('');
  });

  it('should handle quoted commas and split multiple comma-separated groups', () => {
    const csvContent = `name,phone,group,level\nLynxx,012233678,"SPM Physics, SPM Courses",5`;
    const result = parseCsvString(csvContent);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'form5-Lynxx',
      originalName: 'Lynxx',
      phone: '6012233678', // cleaned & standardized Malaysian format
      groupNames: ['SPM Physics', 'SPM Courses'],
      level: '5',
      isValid: true,
      error: undefined,
    });
  });
});

describe('WhatsApp Command Parser (Perspective: /groups authorization)', () => {
  const teacherJid = '60123456789@s.whatsapp.net';
  const studentJid = '60198765432@s.whatsapp.net';
  const studentJids = [studentJid];

  it('should authorize teacher to query groups', () => {
    const result = parseCommand('/groups', teacherJid, teacherJid, studentJids);
    expect(result).toEqual({
      command: 'groups',
      lessonId: null,
      role: 'teacher',
      isAuthorized: true,
      dueDate: null,
    });
  });

  it('should deny students from querying groups', () => {
    const result = parseCommand('/groups', studentJid, teacherJid, studentJids);
    expect(result.command).toBe('groups');
    expect(result.role).toBe('student');
    expect(result.isAuthorized).toBe(false);
  });
});
