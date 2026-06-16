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

    // 2. Create the workshop
    const workshop = await prisma.workshop.create({
      data: {
        subject: body.subject,
        courseId: body.courseId,
        meetingLink: body.meetingLink,
        classDayOfWeek: body.classDayOfWeek,
        classTime: body.classTime,
        teacherId: teacher.id,
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

// Start services and listen
async function main() {
  // Connect to WhatsApp
  await whatsapp.connect();
  // Start orchestrator listeners
  await orchestrator.start();

  // Schedule cron job to run the reminder engine every hour on the hour
  cron.schedule('0 * * * *', async () => {
    try {
      await orchestrator.runReminderCron();
    } catch (err: any) {
      console.error(`Cron reminder run failed: ${err.message}`);
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
