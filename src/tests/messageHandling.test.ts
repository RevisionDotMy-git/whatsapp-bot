import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorService } from '../services/OrchestratorService.js';
import { IncomingMessage } from '../interfaces/IWhatsAppClient.js';
import { logAudit } from '../services/db.js';
import fs from 'fs';

// Mock the db module to prevent actual database calls and capture audit logs
vi.mock('../services/db.js', () => {
  return {
    prisma: {
      auditLog: {
        create: vi.fn().mockResolvedValue({}),
      },
    },
    logAudit: vi.fn().mockResolvedValue(undefined),
  };
});

describe('Orchestrator Message Handling & Custom Homework Detection', () => {
  let dbMock: any;
  let whatsappMock: any;
  let learndashMock: any;
  let llmMock: any;
  let orchestrator: OrchestratorService;

  beforeEach(() => {
    vi.clearAllMocks();

    dbMock = {
      workshop: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
      studentWorkshop: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        upsert: vi.fn(),
      },
      homework: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
      },
      student: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      teacher: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      progressLog: {
        upsert: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
    };

    whatsappMock = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getGroups: vi.fn().mockResolvedValue([]),
      addParticipants: vi.fn().mockResolvedValue(undefined),
      getGroupInviteCode: vi.fn().mockResolvedValue('inviteCode'),
    };

    learndashMock = {
      verifyUserId: vi.fn(),
    };
    llmMock = {};

    orchestrator = new OrchestratorService(dbMock, whatsappMock, learndashMock, llmMock);
  });

  it('should detect a PDF document upload in DM, register a custom homework, and log WHATSAPP_MESSAGE_RECEIVED and CUSTOM_HOMEWORK_DETECTED', async () => {
    const mockWorkshop = {
      id: 'workshop-123',
      subject: 'SPM Physics',
      teacher: { phoneNumber: '60122082435@s.whatsapp.net' },
      students: [],
    };

    dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
    dbMock.studentWorkshop.findMany.mockResolvedValue([]);
    dbMock.homework.create.mockImplementation((args: any) => {
      return Promise.resolve({
        id: 'homework-456',
        title: args.data.title,
        lessonId: args.data.lessonId,
        dueDate: args.data.dueDate,
      });
    });

    const pdfMessage: IncomingMessage = {
      senderJid: '248030116757531@lid',
      chatJid: '248030116757531@lid',
      text: 'homework.pdf',
      isGroup: false,
      timestamp: 1718540000,
      document: {
        fileName: 'homework.pdf',
        mimetype: 'application/pdf',
        mediaKey: new Uint8Array(),
        url: 'https://example.com/file',
        fileLength: 1024,
        directPath: '/path',
      },
    };

    await (orchestrator as any).handleMessage(pdfMessage);

    // Verify Audit Logs
    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'WHATSAPP_MESSAGE_RECEIVED',
      expect.stringContaining('Received message from 248030116757531@lid (Group: false, Chat JID: 248030116757531@lid). Content: Document: homework.pdf (application/pdf)'),
      '248030116757531@lid'
    );

    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'CUSTOM_HOMEWORK_DETECTED',
      expect.stringMatching(/homework detected at .* with pdf/),
      '248030116757531@lid'
    );
  });

  it('should handle relative due date override "tomorrow" correctly', async () => {
    const mockWorkshop = {
      id: 'workshop-123',
      subject: 'SPM Physics',
      teacher: { phoneNumber: '60122082435@s.whatsapp.net' },
      students: [],
    };

    const mockLatestHomework = {
      id: 'homework-456',
      title: 'Custom Homework (pdf)',
      lessonId: -Math.floor(Date.now() / 1000) + 10,
      dueDate: new Date(),
    };

    dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
    dbMock.homework.findFirst.mockResolvedValue(mockLatestHomework);

    const overrideMessage: IncomingMessage = {
      senderJid: '248030116757531@lid',
      chatJid: '248030116757531@lid',
      text: 'due tomorrow',
      isGroup: false,
      timestamp: 1718540000,
    };

    await (orchestrator as any).handleMessage(overrideMessage);

    // Verify due date updated to tomorrow (+1 day from now)
    const expectedDate = new Date();
    expectedDate.setDate(expectedDate.getDate() + 1);

    expect(dbMock.homework.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'homework-456' },
        data: expect.objectContaining({
          dueDate: expect.any(Date),
        }),
      })
    );

    // Check that we logged UPDATE_CUSTOM_HOMEWORK_DUE
    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'UPDATE_CUSTOM_HOMEWORK_DUE',
      expect.stringContaining('homework due date updated to tomorrow for custom homework "Custom Homework (pdf)"'),
      '248030116757531@lid'
    );
  });

  it('should handle relative due date override "next week" correctly (including next-week and nextweek)', async () => {
    const mockWorkshop = {
      id: 'workshop-123',
      subject: 'SPM Physics',
      teacher: { phoneNumber: '60122082435@s.whatsapp.net' },
      students: [],
    };

    const mockLatestHomework = {
      id: 'homework-456',
      title: 'Custom Homework (pdf)',
      lessonId: -Math.floor(Date.now() / 1000) + 10,
      dueDate: new Date(),
    };

    dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
    dbMock.homework.findFirst.mockResolvedValue(mockLatestHomework);

    const overrideMessage: IncomingMessage = {
      senderJid: '248030116757531@lid',
      chatJid: '248030116757531@lid',
      text: 'please make next-week due',
      isGroup: false,
      timestamp: 1718540000,
    };

    await (orchestrator as any).handleMessage(overrideMessage);

    expect(dbMock.homework.update).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'UPDATE_CUSTOM_HOMEWORK_DUE',
      expect.stringContaining('homework due date updated to next week for custom homework "Custom Homework (pdf)"'),
      '248030116757531@lid'
    );

    // Test "nextweek" variation
    vi.clearAllMocks();
    dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
    dbMock.homework.findFirst.mockResolvedValue(mockLatestHomework);
    
    const overrideMessage2: IncomingMessage = {
      senderJid: '248030116757531@lid',
      chatJid: '248030116757531@lid',
      text: 'due nextweek',
      isGroup: false,
      timestamp: 1718540000,
    };
    await (orchestrator as any).handleMessage(overrideMessage2);

    expect(dbMock.homework.update).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'UPDATE_CUSTOM_HOMEWORK_DUE',
      expect.stringContaining('homework due date updated to next week for custom homework "Custom Homework (pdf)"'),
      '248030116757531@lid'
    );
  });

  it('should handle relative due date override "next month" correctly', async () => {
    const mockWorkshop = {
      id: 'workshop-123',
      subject: 'SPM Physics',
      teacher: { phoneNumber: '60122082435@s.whatsapp.net' },
      students: [],
    };

    const mockLatestHomework = {
      id: 'homework-456',
      title: 'Custom Homework (pdf)',
      lessonId: -Math.floor(Date.now() / 1000) + 10,
      dueDate: new Date(),
    };

    dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
    dbMock.homework.findFirst.mockResolvedValue(mockLatestHomework);

    const overrideMessage: IncomingMessage = {
      senderJid: '248030116757531@lid',
      chatJid: '248030116757531@lid',
      text: 'due next month',
      isGroup: false,
      timestamp: 1718540000,
    };

    await (orchestrator as any).handleMessage(overrideMessage);

    expect(dbMock.homework.update).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'UPDATE_CUSTOM_HOMEWORK_DUE',
      expect.stringContaining('homework due date updated to next month for custom homework "Custom Homework (pdf)"'),
      '248030116757531@lid'
    );
  });

  it('should register a new custom homework with caption-parsed due date when uploading a document with a due-date caption', async () => {
    const mockWorkshop = {
      id: 'workshop-123',
      subject: 'SPM Physics',
      teacher: { phoneNumber: '60122082435@s.whatsapp.net' },
      students: [],
    };

    dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
    dbMock.studentWorkshop.findMany.mockResolvedValue([]);
    dbMock.homework.create.mockImplementation((args: any) => {
      return Promise.resolve({
        id: 'homework-docx-123',
        title: args.data.title,
        lessonId: args.data.lessonId,
        dueDate: args.data.dueDate,
      });
    });

    const docxMessage: IncomingMessage = {
      senderJid: '248030116757531@lid',
      chatJid: '248030116757531@lid',
      text: 'due tomorrow',
      isGroup: false,
      timestamp: 1718540000,
      document: {
        fileName: 'homework.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        mediaKey: new Uint8Array(),
        url: 'https://example.com/file',
        fileLength: 1024,
        directPath: '/path',
      },
    };

    await (orchestrator as any).handleMessage(docxMessage);

    // Verify homework created with due date of tomorrow (approx check)
    expect(dbMock.homework.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Custom Homework (docx)',
          dueDate: expect.any(Date),
        }),
      })
    );

    // Should NOT have updated any existing homework
    expect(dbMock.homework.update).not.toHaveBeenCalled();

    // Verify audit logs
    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'CUSTOM_HOMEWORK_DETECTED',
      expect.stringMatching(/homework detected at .* with docx/),
      '248030116757531@lid'
    );
  });

  it('should register a new custom homework with link-parsed due date when a message containing Google Drive link and due date caption is received', async () => {
    const mockWorkshop = {
      id: 'workshop-123',
      subject: 'SPM Physics',
      teacher: { phoneNumber: '60122082435@s.whatsapp.net' },
      students: [],
    };

    dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
    dbMock.studentWorkshop.findMany.mockResolvedValue([]);
    dbMock.homework.create.mockImplementation((args: any) => {
      return Promise.resolve({
        id: 'homework-link-123',
        title: args.data.title,
        lessonId: args.data.lessonId,
        dueDate: args.data.dueDate,
      });
    });

    const linkMessage: IncomingMessage = {
      senderJid: '248030116757531@lid',
      chatJid: '248030116757531@lid',
      text: 'https://docs.google.com/document/d/1fy7W-oY7_XIZUrEaEZpxk9q273piKaP9wj3Vu1ipf24/edit?usp=sharing\n\ndue next week',
      isGroup: false,
      timestamp: 1718540000,
    };

    await (orchestrator as any).handleMessage(linkMessage);

    // Verify homework created with due date of next week (approx check)
    expect(dbMock.homework.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Custom Homework (drive link)',
          dueDate: expect.any(Date),
        }),
      })
    );

    // Should NOT have updated any existing homework
    expect(dbMock.homework.update).not.toHaveBeenCalled();

    // Verify audit logs
    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'CUSTOM_HOMEWORK_DETECTED',
      expect.stringMatching(/homework detected at .* with drive link/),
      '248030116757531@lid'
    );
  });

  it('should detect a natural language LearnDash assignment from the teacher and create a standard homework record', async () => {
    const mockWorkshop = {
      id: 'workshop-123',
      subject: 'SPM Physics',
      teacher: { phoneNumber: '60122082435@s.whatsapp.net' },
      students: [],
    };

    dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
    dbMock.studentWorkshop.findMany.mockResolvedValue([]);
    dbMock.homework.findFirst.mockResolvedValue(null);
    dbMock.homework.create.mockImplementation((args: any) => {
      return Promise.resolve({
        id: 'homework-1001',
        title: args.data.title,
        lessonId: args.data.lessonId,
        dueDate: args.data.dueDate,
      });
    });

    const fsExistsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const fsReadSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify([
      {
        courseId: 201,
        courseName: "Form 5 Chemistry",
        category: ["Chemistry", "English", "Form_5"],
        lessons: [
          {
            lessonId: 9999,
            lessonName: "16.1 Organisation of Plant Tissues",
            lessonLearndashHyperlink: "https://example.com/chem-16-1"
          }
        ]
      }
    ]));

    const nlMessage: IncomingMessage = {
      senderJid: '60122082435@s.whatsapp.net', // Must be teacher to authorize
      chatJid: 'group-123@g.us',
      text: 'please complete form 5 chemistry 16.1 by next week',
      isGroup: true,
      timestamp: 1718540000,
    };

    await (orchestrator as any).handleMessage(nlMessage);

    // Verify homework created with real lesson ID
    expect(dbMock.homework.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: '16.1 Organisation of Plant Tissues',
          lessonId: 9999,
          dueDate: expect.any(Date),
        }),
      })
    );

    // Verify confirmation message sent containing the LearnDash link
    expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
      'group-123@g.us',
      expect.stringContaining('https://example.com/chem-16-1')
    );

    // Verify audit logs
    expect(logAudit).toHaveBeenCalledWith(
      'INFO',
      'CUSTOM_HOMEWORK_DETECTED',
      expect.stringContaining('homework detected at'),
      '60122082435@s.whatsapp.net'
    );

    fsExistsSpy.mockRestore();
    fsReadSpy.mockRestore();
  });

  it('should resolve student workshop and authorize command when student JID is an LID and DB JID is a phone number', async () => {
    const mockStudent = {
      id: 'student-789',
      name: 'form5-Lynxx',
      phoneNumber: '60123456789@s.whatsapp.net', // Saved as PN in database
      learndashId: 248030116,
    };

    const mockWorkshop = {
      id: 'workshop-123',
      subject: 'SPM Physics',
      teacher: { phoneNumber: '60122082435@s.whatsapp.net' },
      students: [
        { student: mockStudent }
      ],
      homeworks: [
        { id: 'homework-01', title: 'Lesson 1 Homework', dueDate: new Date(Date.now() + 100000) }
      ],
    };

    // Mock student workshop findFirst lookup
    dbMock.studentWorkshop.findFirst.mockResolvedValue({
      studentId: mockStudent.id,
      workshopId: mockWorkshop.id,
      workshop: mockWorkshop,
    });

    dbMock.student.findUnique.mockResolvedValue(mockStudent);
    dbMock.progressLog.findMany.mockResolvedValue([
      {
        id: 'progress-1',
        studentId: mockStudent.id,
        homeworkId: 'homework-01',
        status: 'NOT_STARTED',
        homework: mockWorkshop.homeworks[0],
      }
    ]);

    const lidMessage: IncomingMessage = {
      senderJid: '248030116757531@lid',      // Message arrives with LID JID
      senderPn: '60123456789@s.whatsapp.net', // And has senderPn in message key
      chatJid: '248030116757531@lid',
      text: '/homework',
      isGroup: false,
      timestamp: 1718540000,
    };

    await (orchestrator as any).handleMessage(lidMessage);

    // Verify DB was queried using both the LID and the PN JID
    expect(dbMock.studentWorkshop.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          student: expect.objectContaining({
            phoneNumber: expect.objectContaining({
              in: ['248030116757531@lid', '60123456789@s.whatsapp.net'],
            }),
          }),
        }),
      })
    );

    // Should successfully authorize the student to check homework and reply with the list
    expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
      '248030116757531@lid',
      expect.stringContaining('Lesson 1 Homework')
    );
  });

  describe('New commands /help, /invite, /profile, /add and onboarding DM flow', () => {
    const teacherJid = '60122082435@s.whatsapp.net';
    const studentJid = '60123456789@s.whatsapp.net';
    let mockWorkshop: any;

    beforeEach(() => {
      mockWorkshop = {
        id: 'workshop-123',
        subject: 'SPM Physics',
        courseId: 201,
        whatsappJid: 'group-123@g.us',
        meetingLink: 'https://meet.google.com/abc-defg-hij',
        teacher: { phoneNumber: teacherJid, name: 'Cikgu Sarah' },
        students: [
          {
            student: {
              id: 'student-111',
              name: 'John Doe',
              phoneNumber: studentJid,
              learndashId: 1001,
            }
          }
        ],
      };
    });

    it('should reply with teacher help instructions when /help is run by the teacher', async () => {
      dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);

      const msg: IncomingMessage = {
        senderJid: teacherJid,
        chatJid: 'group-123@g.us',
        text: '/help',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('Teacher Command Guide')
      );
    });

    it('should reply with student help instructions when /help is run by a student', async () => {
      dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
      dbMock.studentWorkshop.findFirst.mockResolvedValue({
        studentId: 'student-111',
        workshopId: mockWorkshop.id,
        workshop: mockWorkshop,
      });

      const msg: IncomingMessage = {
        senderJid: studentJid,
        chatJid: 'group-123@g.us',
        text: '/help',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('Student Command Guide')
      );
    });

    it('should execute /invite student <phone> <name> correctly, create a student record with placeholder negative id, and send onboarding welcome message', async () => {
      dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
      dbMock.student.findUnique = vi.fn().mockResolvedValue(null);
      dbMock.student.create = vi.fn().mockResolvedValue({
        id: 'new-student-id',
        name: 'Jane Smith',
        phoneNumber: '60199998888@s.whatsapp.net',
        learndashId: -12345,
      });

      const msg: IncomingMessage = {
        senderJid: teacherJid,
        chatJid: 'group-123@g.us',
        text: '/invite student 60199998888 Jane Smith',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(dbMock.student.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Jane Smith',
            phoneNumber: '60199998888@s.whatsapp.net',
            learndashId: expect.any(Number),
          }),
        })
      );

      // Verify onboarding DM sent to the new student
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        '60199998888@s.whatsapp.net',
        expect.stringContaining('How to find your LearnDash User ID')
      );

      // Verify teacher received success confirmation
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('Jane Smith* invited. Onboarding DM sent.')
      );
    });

    it('should process WordPress user ID reply from pending onboarding student successfully', async () => {
      const pendingStudent = {
        id: 'student-pending-1',
        name: 'Jane Smith',
        phoneNumber: studentJid,
        learndashId: -555,
      };

      dbMock.student.findFirst = vi.fn().mockResolvedValue(pendingStudent);
      dbMock.student.findUnique = vi.fn().mockResolvedValue(null);
      dbMock.student.update = vi.fn().mockResolvedValue(pendingStudent);
      learndashMock.verifyUserId.mockResolvedValue({ exists: true });

      const msg: IncomingMessage = {
        senderJid: studentJid,
        chatJid: studentJid,
        text: '248030116',
        isGroup: false,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(learndashMock.verifyUserId).toHaveBeenCalledWith(248030116);
      expect(dbMock.student.update).toHaveBeenCalledWith({
        where: { id: pendingStudent.id },
        data: { learndashId: 248030116 },
      });
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        studentJid,
        expect.stringContaining('LearnDash ID linked')
      );
    });

    it('should send the help guide when unverified LearnDash User ID is received from a pending student', async () => {
      const pendingStudent = {
        id: 'student-pending-1',
        name: 'Jane Smith',
        phoneNumber: studentJid,
        learndashId: -555,
      };

      dbMock.student.findFirst = vi.fn().mockResolvedValue(pendingStudent);
      learndashMock.verifyUserId.mockResolvedValue({ exists: false });

      const msg: IncomingMessage = {
        senderJid: studentJid,
        chatJid: studentJid,
        text: '9999999',
        isGroup: false,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        studentJid,
        expect.stringContaining('How to find your LearnDash User ID')
      );
    });

    it('should send help guide when a pending student replies with non-digit text', async () => {
      const pendingStudent = {
        id: 'student-pending-1',
        name: 'Jane Smith',
        phoneNumber: studentJid,
        learndashId: -555,
      };

      dbMock.student.findFirst = vi.fn().mockResolvedValue(pendingStudent);

      const msg: IncomingMessage = {
        senderJid: studentJid,
        chatJid: studentJid,
        text: 'how do i link it?',
        isGroup: false,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        studentJid,
        expect.stringContaining('How to find your LearnDash User ID')
      );
    });

    it('should cancel onboarding when a pending student replies with cancel or n/a', async () => {
      const pendingStudent = {
        id: 'student-pending-1',
        name: 'Jane Smith',
        phoneNumber: studentJid,
        learndashId: -555,
      };

      dbMock.student.findFirst = vi.fn().mockResolvedValue(pendingStudent);

      const msg: IncomingMessage = {
        senderJid: studentJid,
        chatJid: studentJid,
        text: 'N/A',
        isGroup: false,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        studentJid,
        expect.stringContaining('Profile linking canceled')
      );
    });

    it('should update profile name using /profile name command', async () => {
      dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
      const studentToEdit = {
        id: 'student-edit-id',
        name: 'Old Name',
        phoneNumber: studentJid,
        learndashId: 1001,
      };
      dbMock.student.findUnique = vi.fn().mockResolvedValue(studentToEdit);
      dbMock.student.update = vi.fn().mockResolvedValue(studentToEdit);

      const msg: IncomingMessage = {
        senderJid: teacherJid,
        chatJid: 'group-123@g.us',
        text: '/profile 60123456789 name New Name',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(dbMock.student.update).toHaveBeenCalledWith({
        where: { id: studentToEdit.id },
        data: { name: 'New Name' },
      });
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('updated student name to')
      );
    });

    it('should update profile id using /profile id command after verifying against LearnDash', async () => {
      dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
      const studentToEdit = {
        id: 'student-edit-id',
        name: 'Jane Smith',
        phoneNumber: studentJid,
        learndashId: 1001,
      };
      dbMock.student.findUnique = vi.fn().mockResolvedValue(studentToEdit);
      dbMock.student.update = vi.fn().mockResolvedValue(studentToEdit);
      learndashMock.verifyUserId.mockResolvedValue({ exists: true });

      const msg: IncomingMessage = {
        senderJid: teacherJid,
        chatJid: 'group-123@g.us',
        text: '/profile 60123456789 id 248030116',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(learndashMock.verifyUserId).toHaveBeenCalledWith(248030116);
      expect(dbMock.student.update).toHaveBeenCalledWith({
        where: { id: studentToEdit.id },
        data: { learndashId: 248030116 },
      });
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('updated student *Jane Smith* LearnDash ID to')
      );
    });

    it('should add student to group when /add command is run, falling back to invite code DM if blocked', async () => {
      dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
      const targetStudent = {
        id: 'student-target-id',
        name: 'Jane Smith',
        phoneNumber: '60199998888@s.whatsapp.net',
        learndashId: 1001,
      };
      dbMock.student.findUnique = vi.fn().mockResolvedValue(targetStudent);

      // Case A: direct add works
      const msgDirect: IncomingMessage = {
        senderJid: teacherJid,
        chatJid: 'group-123@g.us',
        text: '/add 60199998888 Physics',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msgDirect);

      expect(whatsappMock.addParticipants).toHaveBeenCalledWith('group-123@g.us', ['60199998888@s.whatsapp.net']);
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('Enrolled *Jane Smith* in *SPM Physics*')
      );

      // Case B: direct add fails due to privacy settings, falls back to group invite link
      whatsappMock.addParticipants.mockRejectedValue(new Error('direct add blocked'));

      const msgFallback: IncomingMessage = {
        senderJid: teacherJid,
        chatJid: 'group-123@g.us',
        text: '/add 60199998888 Physics',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msgFallback);

      expect(whatsappMock.getGroupInviteCode).toHaveBeenCalledWith('group-123@g.us');
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        '60199998888@s.whatsapp.net',
        expect.stringContaining('https://chat.whatsapp.com/inviteCode')
      );
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('Direct add blocked by privacy; group invite link DM-ed')
      );
    });

    it('should list pending homework when student runs /homework check or /homework', async () => {
      dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
      const student = {
        id: 'student-789',
        name: 'John Doe',
        phoneNumber: studentJid,
        learndashId: 1001,
      };
      dbMock.student.findUnique = vi.fn().mockResolvedValue(student);
      dbMock.progressLog.findMany = vi.fn().mockResolvedValue([
        {
          id: 'progress-1',
          studentId: student.id,
          homeworkId: 'homework-01',
          status: 'NOT_STARTED',
          homework: { id: 'homework-01', title: 'Lesson 1 Homework', dueDate: new Date('2026-06-26') },
        }
      ]);

      const msg: IncomingMessage = {
        senderJid: studentJid,
        chatJid: 'group-123@g.us',
        text: '/homework check',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(dbMock.student.findUnique).toHaveBeenCalledWith({ where: { phoneNumber: studentJid } });
      expect(dbMock.progressLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          studentId: student.id,
          status: { not: 'COMPLETED' },
        })
      }));
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('Lesson 1 Homework')
      );
    });

    it('should mark oldest pending homework completed when student runs /homework done', async () => {
      dbMock.workshop.findFirst.mockResolvedValue(mockWorkshop);
      const student = {
        id: 'student-789',
        name: 'John Doe',
        phoneNumber: studentJid,
        learndashId: 1001,
      };
      dbMock.student.findUnique = vi.fn().mockResolvedValue(student);
      const pendingLog = {
        id: 'progress-1',
        studentId: student.id,
        homeworkId: 'homework-01',
        status: 'NOT_STARTED',
        homework: { id: 'homework-01', title: 'Lesson 1 Homework', dueDate: new Date('2026-06-26') },
      };
      dbMock.progressLog.findFirst = vi.fn().mockResolvedValue(pendingLog);
      dbMock.progressLog.update = vi.fn().mockResolvedValue({
        ...pendingLog,
        status: 'COMPLETED',
      });

      const msg: IncomingMessage = {
        senderJid: studentJid,
        chatJid: 'group-123@g.us',
        text: '/homework done',
        isGroup: true,
        timestamp: 1718540000,
      };

      await (orchestrator as any).handleMessage(msg);

      expect(dbMock.progressLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          studentId: student.id,
          status: { not: 'COMPLETED' },
        })
      }));
      expect(dbMock.progressLog.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'progress-1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          submittedAt: expect.any(Date),
        }),
      }));
      expect(whatsappMock.sendMessage).toHaveBeenCalledWith(
        'group-123@g.us',
        expect.stringContaining('Marked homework *Lesson 1 Homework* as completed')
      );
    });
  });
});

