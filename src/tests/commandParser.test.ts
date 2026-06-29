import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand } from '../utils/commandParser.js';

describe('WhatsApp Command Parser', () => {
  const teacherJid = '60123456789@s.whatsapp.net';
  const botJid = '60199999999@s.whatsapp.net';
  const studentJid = '60198765432@s.whatsapp.net';
  const strangerJid = '60111223344@s.whatsapp.net';
  const studentJids = [studentJid];

  // Set standard current date for assertions
  const mockNow = new Date('2026-06-16T12:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(mockNow);
  });

  it('should parse teacher homework command correctly and calculate 7-day expiry', () => {
    const messageText = '/homework 852';
    const result = parseCommand(messageText, teacherJid, teacherJid, studentJids);

    expect(result).toEqual({
      command: 'homework',
      lessonId: 852,
      role: 'teacher',
      isAuthorized: true,
      dueDate: new Date('2026-06-23T12:00:00Z'), // Exactly 7 days later
      isValid: true,
      validationError: undefined,
      args: ['852']
    });
  });

  it('should parse teacher homework command with @bot trigger', () => {
    const messageText = '@bot homework 999';
    const result = parseCommand(messageText, teacherJid, teacherJid, studentJids);

    expect(result).toEqual({
      command: 'homework',
      lessonId: 999,
      role: 'teacher',
      isAuthorized: true,
      dueDate: new Date('2026-06-23T12:00:00Z'),
      isValid: true,
      validationError: undefined,
      args: ['999']
    });
  });

  it('should parse student meeting command correctly', () => {
    const messageText = '/meeting';
    const result = parseCommand(messageText, studentJid, teacherJid, studentJids);

    expect(result).toEqual({
      command: 'meeting',
      lessonId: null,
      role: 'student',
      isAuthorized: true,
      dueDate: null,
      isValid: true,
      validationError: undefined,
      args: []
    });
  });

  it('should deny student access to teacher-only commands (like /report)', () => {
    const messageText = '/report';
    const result = parseCommand(messageText, studentJid, teacherJid, studentJids);

    expect(result.command).toBe('report');
    expect(result.role).toBe('student');
    expect(result.isAuthorized).toBe(false);
  });

  it('should identify strangers as unauthorized and unknown role', () => {
    const messageText = '/homework 123';
    const result = parseCommand(messageText, strangerJid, teacherJid, studentJids);

    expect(result.role).toBe('unknown');
    expect(result.isAuthorized).toBe(false);
  });

  it('should return null for non-command messages', () => {
    const messageText = 'Hello teacher, I have a question about class';
    const result = parseCommand(messageText, studentJid, teacherJid, studentJids);
    expect(result).toBeNull();
  });

  it('should return null for unrecognized commands to avoid spamming the group', () => {
    const messageText = '/hello';
    const result = parseCommand(messageText, studentJid, teacherJid, studentJids);
    expect(result).toBeNull();
  });

  it('should allow students to view homework list (no arguments)', () => {
    const messageText = '/homework';
    const result = parseCommand(messageText, studentJid, teacherJid, studentJids);
    expect(result).toEqual({
      command: 'homework',
      lessonId: null,
      role: 'student',
      isAuthorized: true,
      dueDate: null,
      isValid: true,
      validationError: undefined,
      args: []
    });
  });

  it('should deny students from assigning homework (with arguments)', () => {
    const messageText = '/homework 123';
    const result = parseCommand(messageText, studentJid, teacherJid, studentJids);
    expect(result.command).toBe('homework');
    expect(result.isAuthorized).toBe(false);
  });

  it('should authorize bot JID when passed in an array of teacher JIDs', () => {
    const messageText = '/groups';
    const result = parseCommand(messageText, botJid, [teacherJid, botJid], studentJids);

    expect(result).toEqual({
      command: 'groups',
      lessonId: null,
      role: 'teacher',
      isAuthorized: true,
      dueDate: null,
      isValid: true,
      validationError: undefined,
      args: []
    });
  });

  it('should return isValid = false with custom error if registry validation fails', () => {
    const messageText = '/invite student'; // Missing phone and name
    const result = parseCommand(messageText, teacherJid, teacherJid, studentJids);

    expect(result.isValid).toBe(false);
    expect(result.validationError).toBe('Usage: `/invite student|teacher <phone> <name>`');
  });

  it('should parse homework delete command correctly', () => {
    const messageText = '/homework delete 543';
    const result = parseCommand(messageText, teacherJid, teacherJid, studentJids);

    expect(result).toMatchObject({
      command: 'homework',
      lessonId: 543,
      role: 'teacher',
      isAuthorized: true,
      isValid: true,
      args: ['delete', '543']
    });
  });

  it('should parse remove command correctly', () => {
    const messageText = '/remove student 60123456789 SPM Physics';
    const result = parseCommand(messageText, teacherJid, teacherJid, studentJids);

    expect(result).toMatchObject({
      command: 'remove',
      role: 'teacher',
      isAuthorized: true,
      isValid: true,
      args: ['student', '60123456789', 'SPM', 'Physics']
    });
  });

  it('should parse unlink command correctly', () => {
    const messageText = '/unlink';
    const result = parseCommand(messageText, studentJid, teacherJid, studentJids);

    expect(result).toMatchObject({
      command: 'unlink',
      role: 'student',
      isAuthorized: true,
      isValid: true,
      args: []
    });
  });

  it('should parse homework command with suffix due date "due tomorrow" correctly', () => {
    const messageText = '/homework 1234 due tomorrow';
    const result = parseCommand(messageText, teacherJid, teacherJid, studentJids);

    expect(result).toMatchObject({
      command: 'homework',
      lessonId: 1234,
      role: 'teacher',
      isAuthorized: true,
      isValid: true,
      args: ['1234']
    });
    expect(result!.dueDate!.getDate()).toBe(new Date(mockNow.getTime() + 24 * 60 * 60 * 1000).getDate());
  });

  it('should parse homework command with non-numeric query and due date correctly', () => {
    const messageText = '/homework physics waves next week';
    const result = parseCommand(messageText, teacherJid, teacherJid, studentJids);

    expect(result).toMatchObject({
      command: 'homework',
      lessonId: null,
      role: 'teacher',
      isAuthorized: true,
      isValid: true,
      args: ['physics', 'waves']
    });
    expect(result!.dueDate!.getDate()).toBe(new Date(mockNow.getTime() + 7 * 24 * 60 * 60 * 1000).getDate());
  });
});
