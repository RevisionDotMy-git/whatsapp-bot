import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import cron from 'node-cron';
import { prisma, logAudit } from './services/db.js';
import { WhatsAppService } from './services/WhatsAppService.js';
import { LearnDashService } from './services/LearnDashService.js';
import { LLMService } from './services/LLMService.js';
import { OrchestratorService } from './services/OrchestratorService.js';
import { CONFIG } from './config/constants.js';
import { EnvDiagnostics } from './modules/envDiagnostics/EnvDiagnostics.js';

const server = fastify({ logger: true });

// Serve static assets from public folder
server.register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  prefix: '/',
});

// Instantiate services
const whatsapp = new WhatsAppService();
const learndash = new LearnDashService();
const llm = new LLMService();
const orchestrator = new OrchestratorService(prisma, whatsapp, learndash, llm);

/**
 * Endpoint to register a new Workshop
 */
server.post('/api/workshop', async (request, reply) => {
  const body = request.body as {
    subject: string;
    courseId: number;
    meetingLink?: string;
    classDayOfWeek: number; // 0 = Sun, 1 = Mon...
    classTime: string; // "HH:MM"
    teacherName: string;
    teacherPhone: string;
  };

  try {
    // 1. Resolve or create teacher
    const teacher = await prisma.teacher.upsert({
      where: { phoneNumber: body.teacherPhone },
      create: { name: body.teacherName, phoneNumber: body.teacherPhone },
      update: { name: body.teacherName },
    });

    // 2. Resolve or generate meeting link (default to Google Meet)
    let meetingLink = body.meetingLink;
    if (!meetingLink || meetingLink.trim() === '') {
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      const randSegment = (len: number) => Array.from({ length: len }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
      meetingLink = `https://meet.google.com/${randSegment(3)}-${randSegment(4)}-${randSegment(3)}`;
    }

    // Create WhatsApp group if client is connected
    let groupJid: string | null = null;
    if (whatsapp.isConnected()) {
      try {
        const groupName = `${body.subject} - Class`;
        groupJid = await whatsapp.createGroup(groupName, [teacher.phoneNumber]);
        await whatsapp.promoteAdmins(groupJid, [teacher.phoneNumber]);
      } catch (grpErr: any) {
        await logAudit('WARN', 'API_CLASS_CREATE_GROUP_FAILED', `Failed to automatically create WhatsApp group for class: ${grpErr.message}`);
      }
    }

    // 2. Create the workshop
    const workshop = await prisma.workshop.create({
      data: {
        subject: body.subject,
        courseId: body.courseId,
        meetingLink: meetingLink,
        classDayOfWeek: body.classDayOfWeek,
        classTime: body.classTime,
        teacherId: teacher.id,
        whatsappJid: groupJid,
      },
    });

    await logAudit('INFO', 'API_WORKSHOP_CREATE', `Workshop "${body.subject}" created for teacher ${body.teacherName}.`);

    return reply.status(201).send({
      message: 'Workshop successfully registered.',
      workshopId: workshop.id,
    });
  } catch (err: any) {
    server.log.error(err);
    await logAudit('ERROR', 'API_WORKSHOP_CREATE_FAIL', `Workshop creation failed: ${err.message}`);
    return reply.status(500).send({ error: 'Failed to create workshop.' });
  }
});

/**
 * Endpoint to bulk-import students via JSON payload (uploaded from React WebUI)
 */
server.post('/api/workshop/:id/students/import', async (request, reply) => {
  const { id: workshopId } = request.params as { id: string };
  const students = request.body as { name: string; phoneNumber: string; learndashId: number }[];

  try {
    const workshop = await prisma.workshop.findUnique({
      where: { id: workshopId },
      include: { teacher: true },
    });

    if (!workshop) {
      return reply.status(404).send({ error: 'Workshop not found.' });
    }

    const createdStudentJids: string[] = [];

    for (const studentData of students) {
      // Create or update Student
      const student = await prisma.student.upsert({
        where: { phoneNumber: studentData.phoneNumber },
        create: {
          name: studentData.name,
          phoneNumber: studentData.phoneNumber,
          learndashId: studentData.learndashId,
        },
        update: {
          name: studentData.name,
          learndashId: studentData.learndashId,
        },
      });

      // Enroll in Workshop
      await prisma.studentWorkshop.upsert({
        where: {
          studentId_workshopId: {
            studentId: student.id,
            workshopId,
          },
        },
        create: {
          studentId: student.id,
          workshopId,
        },
        update: {},
      });

      createdStudentJids.push(student.phoneNumber);
    }

    await logAudit(
      'INFO',
      'API_STUDENTS_IMPORT',
      `Imported and enrolled ${students.length} students to workshop "${workshop.subject}".`
    );

    // Orchestrate WhatsApp Group creation asynchronously
    setImmediate(async () => {
      try {
        // Create standard WhatsApp group with teacher & students
        const allParticipants = [workshop.teacher.phoneNumber, ...createdStudentJids];
        const groupJid = await whatsapp.createGroup(workshop.subject, allParticipants);

        // Update group info in database
        await prisma.workshop.update({
          where: { id: workshopId },
          data: { whatsappJid: groupJid },
        });

        // Promote the teacher as group admin
        await whatsapp.promoteAdmins(groupJid, [workshop.teacher.phoneNumber]);
        
        // Post welcome announcement
        await whatsapp.sendMessage(
          groupJid,
          `👋 Welcome to the *${workshop.subject}* Revision Class WhatsApp group!\n\n` +
          `👩‍🏫 Teacher Admin: *${workshop.teacher.name}*\n` +
          `🤖 Class Assistant Bot has been successfully linked.\n\n` +
          `*Class Details:*\n` +
          `- Schedule: Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][workshop.classDayOfWeek]} at ${workshop.classTime}\n` +
          `- Class Link: ${workshop.meetingLink || 'TBA'}\n\n` +
          `_You will receive direct messages from this Bot for homework reminders!_`
        );
      } catch (groupErr: any) {
        await logAudit(
          'ERROR',
          'WHATSAPP_GROUP_ORCHESTRATION_FAIL',
          `Failed orchestrating group for workshop ID ${workshopId}: ${groupErr.message}`
        );
      }
    });

    return reply.send({
      message: `Enrolled ${students.length} students. Group orchestration triggered in background.`,
    });
  } catch (err: any) {
    server.log.error(err);
    await logAudit('ERROR', 'API_STUDENTS_IMPORT_FAIL', `Student import failed: ${err.message}`);
    return reply.status(500).send({ error: 'Failed to import students.' });
  }
});

/**
 * Endpoint to enroll an individual student to a Workshop
 */
server.post('/api/workshop/:id/student', async (request, reply) => {
  const { id: workshopId } = request.params as { id: string };
  const studentData = request.body as { name: string; phoneNumber: string; learndashId: number };

  try {
    const workshop = await prisma.workshop.findUnique({
      where: { id: workshopId },
      include: { teacher: true },
    });

    if (!workshop) {
      return reply.status(404).send({ error: 'Workshop not found.' });
    }

    // 1. Create or update student record
    const student = await prisma.student.upsert({
      where: { phoneNumber: studentData.phoneNumber },
      create: {
        name: studentData.name,
        phoneNumber: studentData.phoneNumber,
        learndashId: studentData.learndashId,
      },
      update: {
        name: studentData.name,
        learndashId: studentData.learndashId,
      },
    });

    // 2. Enroll in Workshop
    await prisma.studentWorkshop.upsert({
      where: {
        studentId_workshopId: {
          studentId: student.id,
          workshopId,
        },
      },
      create: {
        studentId: student.id,
        workshopId,
      },
      update: {},
    });

    await logAudit(
      'INFO',
      'API_STUDENT_ENROLLED',
      `Registered and enrolled student "${student.name}" to workshop "${workshop.subject}".`
    );

    // 3. Asynchronously invite/add student to the WhatsApp group
    setImmediate(async () => {
      if (workshop.whatsappJid) {
        try {
          // Attempt to add student directly
          await whatsapp.addParticipants(workshop.whatsappJid, [student.phoneNumber]);
          await whatsapp.sendMessage(
            workshop.whatsappJid,
            `👋 Welcome *${student.name}* to our *${workshop.subject}* WhatsApp group class!`
          );
        } catch (addErr: any) {
          // Direct add failed (privacy settings). Fall back to invite link.
          try {
            const code = await whatsapp.getGroupInviteCode(workshop.whatsappJid);
            const inviteUrl = `https://chat.whatsapp.com/${code}`;
            
            await whatsapp.sendMessage(
              student.phoneNumber,
              `👋 Hello *${student.name}*!\n` +
              `You have been enrolled in *${workshop.subject}* class.\n` +
              `Please tap this link to join the class WhatsApp group:\n` +
              `🔗 ${inviteUrl}`
            );
          } catch (inviteErr: any) {
            await logAudit(
              'ERROR',
              'WHATSAPP_STUDENT_ADD_FAIL',
              `Failed adding student to group and sending invite URL: ${inviteErr.message}`,
              student.phoneNumber
            );
          }
        }
      }

      // If student is pending profile linking, send onboarding DM
      if (student.learndashId < 0) {
        try {
          const welcomeMessage = 
            `👋 Hello *${student.name}*!\n` +
            `You have been registered for class tracking.\n\n` +
            `Please reply directly to this message with your *WordPress/LearnDash User ID* (numbers only) to link your account.\n\n` +
            `👉 Reply with: your ID number (e.g. *12345*)\n` +
            `❌ Reply with: *N/A* to cancel this update.\n\n` +
            `ℹ️ *How to find your LearnDash User ID*:\n` +
            `1. Log in to your account at *course.revision.my*\n` +
            `2. Tap on "Profile" (under the menu or avatar).\n` +
            `3. Your User ID is displayed under your profile avatar/name, or visible in your browser profile URL.`;
          
          await whatsapp.sendMessage(student.phoneNumber, welcomeMessage);
        } catch (err: any) {
          await logAudit('ERROR', 'API_STUDENT_ONBOARDING_DM_FAIL', `Failed sending onboarding DM to ${student.phoneNumber}: ${err.message}`);
        }
      }
    });

    return reply.send({
      message: `Enrolled student "${student.name}". Group sync triggered in background.`,
      studentId: student.id,
    });
  } catch (err: any) {
    server.log.error(err);
    await logAudit('ERROR', 'API_STUDENT_ENROLL_FAIL', `Individual student enrollment failed: ${err.message}`);
    return reply.status(500).send({ error: 'Failed to enroll student.' });
  }
});

/**
 * Webhook triggered when a student submits an assignment on LearnDash
 */
server.post('/api/webhook/submission', async (request, reply) => {
  const payload = request.body as {
    userId: number; // LearnDash Student User ID
    lessonId: number;
    assignmentId: number;
    essayText: string;
    questionTitle: string;
    teacherAnswerKey?: string; // Optional reference key provided by teacher
  };

  try {
    // 1. Verify student and active homework in DB
    const student = await prisma.student.findUnique({
      where: { learndashId: payload.userId },
    });

    if (!student) {
      return reply.status(404).send({ error: 'Student matching LearnDash ID not found in database.' });
    }

    const homework = await prisma.homework.findFirst({
      where: { lessonId: payload.lessonId },
      include: { workshop: true },
    });

    if (!homework) {
      return reply.status(404).send({ error: 'Active homework tracking not found for this lesson ID.' });
    }

    // 2. Invoke Gemini LLM for essay evaluation
    const reference = payload.teacherAnswerKey || 'Please grade the student based on default academic spelling and core topic completeness.';
    const evaluation = await llm.evaluateEssay(payload.questionTitle, reference, payload.essayText);

    // 3. Post grade and comment back to LearnDash
    await learndash.submitGradeAndComment(payload.assignmentId, evaluation.score, evaluation.feedback);

    // 4. Update local progress record
    await prisma.progressLog.upsert({
      where: {
        studentId_homeworkId: {
          studentId: student.id,
          homeworkId: homework.id,
        },
      },
      create: {
        studentId: student.id,
        homeworkId: homework.id,
        status: 'COMPLETED',
        score: evaluation.score,
        feedback: evaluation.feedback,
        submittedAt: new Date(),
      },
      update: {
        status: 'COMPLETED',
        score: evaluation.score,
        feedback: evaluation.feedback,
        submittedAt: new Date(),
      },
    });

    // 5. Direct Message the student confirming their submission has been processed
    await whatsapp.sendMessage(
      student.phoneNumber,
      `📝 *Homework Graded!* 📝\n\n` +
      `Hi *${student.name}*,\n` +
      `Your submission for *${homework.title}* has been graded.\n\n` +
      `💯 *Score*: ${evaluation.score}%\n` +
      `💬 *Feedback Highlights*:\n${evaluation.feedback.substring(0, 300)}...`
    );

    return reply.send({ message: 'Evaluation complete, grade uploaded.', score: evaluation.score });
  } catch (err: any) {
    server.log.error(err);
    await logAudit('ERROR', 'API_WEBHOOK_SUBMISSION_FAIL', `Webhook processing failed: ${err.message}`);
    return reply.status(500).send({ error: 'Failed to process assignment webhook.' });
  }
});

/**
 * GET /api/workshops
 * Lists all workshops with teacher details and student counts
 */
server.get('/api/workshops', async (request, reply) => {
  try {
    const workshops = await prisma.workshop.findMany({
      include: {
        teacher: true,
        students: {
          include: { student: true }
        }
      }
    });
    return workshops;
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: 'Failed to retrieve workshops.' });
  }
});

/**
 * GET /api/workshops/:id/students
 * Lists all students enrolled in a specific workshop
 */
server.get('/api/workshops/:id/students', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const enrollments = await prisma.studentWorkshop.findMany({
      where: { workshopId: id },
      include: { student: true }
    });
    return enrollments.map(e => e.student);
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: 'Failed to retrieve students.' });
  }
});

/**
 * GET /api/workshops/:id/homeworks
 * Lists all homework tasks for a specific workshop
 */
server.get('/api/workshops/:id/homeworks', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const homeworks = await prisma.homework.findMany({
      where: { workshopId: id },
      orderBy: { dueDate: 'asc' }
    });
    return homeworks;
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: 'Failed to retrieve homeworks.' });
  }
});

/**
 * POST /api/workshops/:id/homeworks
 * Registers a new homework task for the workshop
 */
server.post('/api/workshops/:id/homeworks', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { lessonId, dueDate } = request.body as { lessonId: number; dueDate: string };

  if (!lessonId || !dueDate) {
    return reply.status(400).send({ error: 'lessonId and dueDate are required.' });
  }

  try {
    const title = `Lesson ${lessonId} Homework`;
    const homework = await prisma.homework.create({
      data: {
        workshopId: id,
        lessonId,
        title,
        dueDate: new Date(dueDate)
      }
    });

    // Create initial ProgressLogs for all enrolled students
    const enrollments = await prisma.studentWorkshop.findMany({
      where: { workshopId: id }
    });

    for (const enrollment of enrollments) {
      await prisma.progressLog.upsert({
        where: {
          studentId_homeworkId: {
            studentId: enrollment.studentId,
            homeworkId: homework.id
          }
        },
        create: {
          studentId: enrollment.studentId,
          homeworkId: homework.id,
          status: 'NOT_STARTED'
        },
        update: {}
      });
    }

    await logAudit('INFO', 'CREATE_HOMEWORK_API', `Created homework for Lesson ID ${lessonId} via WebUI.`, 'WebUI');
    return homework;
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: 'Failed to register homework.' });
  }
});


/**
 * Helper to fetch all pages from WordPress REST API (handles pagination)
 */
async function fetchAllFromWordPress(baseUrl: string, token: string): Promise<any[]> {
  let allItems: any[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${separator}per_page=100&page=${page}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (page === 1) {
        throw new Error(`LearnDash returned status ${response.status}`);
      }
      break;
    }

    const items = await response.json();
    if (!Array.isArray(items) || items.length === 0) {
      hasNext = false;
    } else {
      allItems = allItems.concat(items);
      if (items.length < 100) {
        hasNext = false;
      } else {
        page++;
      }
    }
  }
  return allItems;
}

/**
 * GET /api/learndash/courses
 * Reads courses directly from the local JSON cache
 */
server.get('/api/learndash/courses', async (request, reply) => {
  try {
    const cachedCourses = learndash.getCachedData();
    return cachedCourses.map(c => ({
      id: c.courseId,
      title: { rendered: c.courseName },
      slug: c.courseName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    }));
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: 'Failed to retrieve courses from cache.' });
  }
});

/**
 * GET /api/learndash/courses/:courseId/lessons
 * Reads course lessons directly from the local JSON cache
 */
server.get('/api/learndash/courses/:courseId/lessons', async (request, reply) => {
  const { courseId } = request.params as { courseId: string };
  try {
    const cId = parseInt(courseId, 10);
    const cachedCourses = learndash.getCachedData();
    const course = cachedCourses.find(c => c.courseId === cId);
    
    if (!course) {
      return [];
    }

    return course.lessons.map(l => ({
      id: l.lessonId,
      title: { rendered: l.lessonName }
    }));
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: `Failed to retrieve lessons for course ${courseId} from cache.` });
  }
});

/**
 * POST /api/learndash/sync
 * Force sync courses and lessons from LearnDash to local JSON cache
 */
server.post('/api/learndash/sync', async (request, reply) => {
  try {
    const data = await learndash.syncAllWithLearnDash();
    return {
      success: true,
      message: 'LearnDash cache successfully updated.',
      coursesCount: data.length
    };
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: `Force sync failed: ${err.message}` });
  }
});


/**
 * POST /api/workshops/:id/reminders/trigger
 * Manually triggers progress check and reminder cycle for a workshop
 */
server.post('/api/workshops/:id/reminders/trigger', async (request, reply) => {
  try {
    await orchestrator.runReminderCron();
    await logAudit('INFO', 'TRIGGER_REMINDERS_API', 'Manually triggered progress validation and reminder cycle via WebUI.', 'WebUI');
    return { success: true, message: 'Progress check and reminder validation cycle finished.' };
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: `Reminder cycle failed: ${err.message}` });
  }
});

/**
 * GET /api/workshops/:id/report
 * Compiles progress report for a workshop
 */
server.get('/api/workshops/:id/report', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const reportText = await orchestrator.compileProgressReport(id);
    return { report: reportText };
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: 'Failed to compile progress report.' });
  }
});

/**
 * GET /api/audit-logs
 * Retrieves the 50 most recent audit logs
 */
server.get('/api/audit-logs', async (request, reply) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 50
    });
    return logs;
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: 'Failed to retrieve audit logs.' });
  }
});

/**
 * Endpoint to delete a Workshop class
 */
server.delete('/api/workshops/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const workshop = await prisma.workshop.findUnique({ where: { id } });
    if (!workshop) {
      return reply.status(404).send({ error: 'Workshop not found.' });
    }
    await prisma.workshop.delete({ where: { id } });
    await logAudit('INFO', 'API_WORKSHOP_DELETE', `Workshop "${workshop.subject}" (ID: ${id}) deleted via API.`);
    return reply.status(200).send({ message: 'Workshop deleted successfully.' });
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: `Failed to delete workshop: ${err.message}` });
  }
});

/**
 * Endpoint to delete a Homework assignment by lesson ID
 */
server.delete('/api/workshops/:id/homeworks/:lessonId', async (request, reply) => {
  const { id: workshopId, lessonId: rawLessonId } = request.params as { id: string; lessonId: string };
  try {
    const lessonId = parseInt(rawLessonId, 10);
    if (isNaN(lessonId)) {
      return reply.status(400).send({ error: 'Invalid lesson ID.' });
    }
    const homework = await prisma.homework.findFirst({
      where: { workshopId, lessonId }
    });
    if (!homework) {
      return reply.status(404).send({ error: 'Homework not found.' });
    }
    await prisma.homework.delete({ where: { id: homework.id } });
    await logAudit('INFO', 'API_HOMEWORK_DELETE', `Homework for lesson ${lessonId} deleted from workshop ${workshopId} via API.`);
    return reply.status(200).send({ message: 'Homework deleted successfully.' });
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: `Failed to delete homework: ${err.message}` });
  }
});

/**
 * Endpoint to invite a new teacher or student
 */
server.post('/api/invite', async (request, reply) => {
  const body = request.body as { role: 'student' | 'teacher'; phoneNumber: string; name: string };
  try {
    const targetJid = body.phoneNumber.includes('@') ? body.phoneNumber : `${body.phoneNumber.replace(/\D/g, '')}@s.whatsapp.net`;
    
    if (body.role === 'student') {
      const isTeacher = await prisma.teacher.findUnique({ where: { phoneNumber: targetJid } });
      if (isTeacher) {
        return reply.status(400).send({ error: 'JID is already registered as a Teacher.' });
      }
      
      let student = await prisma.student.findUnique({ where: { phoneNumber: targetJid } });
      if (student) {
        return reply.status(400).send({ error: 'Student is already registered.' });
      }
      
      const placeholderId = -Math.floor(Date.now() / 1000);
      student = await prisma.student.create({
        data: { name: body.name, phoneNumber: targetJid, learndashId: placeholderId }
      });
      
      await whatsapp.sendMessage(
        targetJid,
        `👋 Hello *${body.name}*!\n\n` +
        `Welcome to the Revision Workshop! I am the automated class assistant bot.\n\n` +
        `Please reply directly to this message with your *WordPress/LearnDash User ID* (numbers only) to link your account.`
      );
      
      await logAudit('INFO', 'API_INVITE_STUDENT', `Invited student ${body.name} (${targetJid}) via API.`);
      return reply.status(201).send({ message: 'Student invited successfully.', student });
    } else {
      const isStudent = await prisma.student.findUnique({ where: { phoneNumber: targetJid } });
      if (isStudent) {
        return reply.status(400).send({ error: 'JID is already registered as a Student.' });
      }
      
      const teacher = await prisma.teacher.upsert({
        where: { phoneNumber: targetJid },
        create: { name: body.name, phoneNumber: targetJid },
        update: { name: body.name }
      });
      
      await logAudit('INFO', 'API_INVITE_TEACHER', `Invited teacher ${body.name} (${targetJid}) via API.`);
      return reply.status(201).send({ message: 'Teacher invited successfully.', teacher });
    }
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: `Failed to invite user: ${err.message}` });
  }
});

/**
 * Endpoint to remove a teacher or student globally or from a specific class
 */
server.post('/api/remove', async (request, reply) => {
  const body = request.body as { role: 'student' | 'teacher'; phoneNumber: string; subject?: string };
  try {
    const targetJid = body.phoneNumber.includes('@') ? body.phoneNumber : `${body.phoneNumber.replace(/\D/g, '')}@s.whatsapp.net`;
    
    if (body.role === 'teacher') {
      const teacher = await prisma.teacher.findUnique({
        where: { phoneNumber: targetJid },
        include: { workshops: true }
      });
      if (!teacher) {
        return reply.status(404).send({ error: 'Teacher not found.' });
      }
      if (teacher.workshops.length > 0) {
        return reply.status(400).send({ error: `Cannot delete teacher. They are assigned to active classes: ${teacher.workshops.map(w => w.subject).join(', ')}` });
      }
      await prisma.teacher.delete({ where: { id: teacher.id } });
      await logAudit('INFO', 'API_REMOVE_TEACHER', `Removed teacher ${teacher.name} globally via API.`);
      return reply.status(200).send({ message: 'Teacher removed globally.' });
    } else {
      const student = await prisma.student.findUnique({
        where: { phoneNumber: targetJid },
        include: { enrollments: { include: { workshop: true } } }
      });
      if (!student) {
        return reply.status(404).send({ error: 'Student not found.' });
      }
      
      if (body.subject) {
        const enrollment = student.enrollments.find(e => e.workshop.subject.toLowerCase() === body.subject!.toLowerCase());
        if (!enrollment) {
          return reply.status(400).send({ error: `Student is not enrolled in class: ${body.subject}` });
        }
        await prisma.studentWorkshop.delete({
          where: {
            studentId_workshopId: {
              studentId: student.id,
              workshopId: enrollment.workshopId
            }
          }
        });
        await logAudit('INFO', 'API_REMOVE_STUDENT_CLASS', `Unenrolled student ${student.name} from class ${body.subject} via API.`);
        return reply.status(200).send({ message: `Student unenrolled from class ${body.subject}.` });
      } else {
        await prisma.student.delete({ where: { id: student.id } });
        await logAudit('INFO', 'API_REMOVE_STUDENT_GLOBAL', `Removed student ${student.name} globally via API.`);
        return reply.status(200).send({ message: 'Student removed globally.' });
      }
    }
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: `Failed to remove user: ${err.message}` });
  }
});

/**
 * Endpoint to send a custom WhatsApp message/announcement
 */
server.post('/api/send-message', async (request, reply) => {
  const body = request.body as { jid: string; text: string };
  try {
    if (!body.jid || !body.text) {
      return reply.status(400).send({ error: 'JID and text are required.' });
    }
    const targetJid = body.jid.includes('@') ? body.jid : `${body.jid.replace(/\D/g, '')}@s.whatsapp.net`;
    await whatsapp.sendMessage(targetJid, body.text);
    await logAudit('INFO', 'API_SEND_MESSAGE', `Sent message to ${targetJid} via API.`);
    return reply.status(200).send({ message: 'Message sent successfully.' });
  } catch (err: any) {
    server.log.error(err);
    return reply.status(500).send({ error: `Failed to send message: ${err.message}` });
  }
});

// Start services and listen
async function main() {
  // Run startup diagnostics
  const diagnostics = new EnvDiagnostics(prisma);
  const diagnosticsPassed = await diagnostics.runAllChecks();
  if (!diagnosticsPassed) {
    console.error('🩺 Critical startup checks failed. Shutting down...');
    process.exit(1);
  }

  // Connect to WhatsApp
  await whatsapp.connect();
  // Start orchestrator listeners
  await orchestrator.start();

  // Run initial LearnDash cache sync in background if file does not exist
  if (!learndash.isCacheAvailable()) {
    console.log('LearnDash local cache not found. Triggering initial synchronization in background...');
    setImmediate(async () => {
      try {
        await learndash.syncAllWithLearnDash();
        console.log('Initial LearnDash cache sync finished successfully.');
      } catch (err: any) {
        console.error(`Initial LearnDash cache sync failed: ${err.message}`);
      }
    });
  }

  // Schedule cron job to run the reminder engine every hour on the hour
  cron.schedule('0 * * * *', async () => {
    try {
      await orchestrator.runReminderCron();
    } catch (err: any) {
      console.error(`Cron reminder run failed: ${err.message}`);
    }
  });

  // Schedule cron job to sync LearnDash cache every 14 days (2 weeks)
  cron.schedule('0 0 */14 * *', async () => {
    try {
      console.log('Running periodic biweekly LearnDash cache synchronization...');
      await learndash.syncAllWithLearnDash();
    } catch (err: any) {
      console.error(`Periodic LearnDash cache sync failed: ${err.message}`);
    }
  });

  // Start Fastify REST server
  try {
    const address = await server.listen({ port: CONFIG.PORT, host: '0.0.0.0' });
    console.log(`Server listening at ${address}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
