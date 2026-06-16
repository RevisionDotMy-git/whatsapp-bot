# Revision Workshop Management System (v0.0.1) - Documentation

This project is a virtual online class management system and automated teacher assistant. It coordinates student learning progress, manages WhatsApp group setup, handles reminders, and processes LLM-assisted grading of essay submissions.

---

## Technical Architecture

The project is structured under **Clean Architecture** principles to follow **SOLID**, **KISS**, and **DRY** guidelines:

1. **Abstractions & Interfaces (`src/interfaces/`)**:
   - `IWhatsAppClient`: Abstraction layer for WhatsApp group management, direct messaging, and participant roles.
   - `ILearnDashClient`: Abstraction layer for WordPress LearnDash REST API progress synchronization, assignment extraction, and grade submission.
   - `ILLMClient`: Abstraction layer for evaluating text essays.
2. **Domain Services (`src/services/`)**:
   - `WhatsAppService`: Implements `IWhatsAppClient` using the WebSocket-based **WhiskeySockets/Baileys** library (low RAM requirement ~50MB).
   - `LearnDashService`: Implements `ILearnDashClient` via WordPress REST API with JWT authentication.
   - `LLMService`: Implements `ILLMClient` using the **Gemini Developer API**.
   - `OrchestratorService`: The core middleware coordinating workflow automation.
3. **Pure Logic Utilities (`src/utils/`)**:
   - `commandParser.ts`: Custom command extraction, role authorization, and 7-day expiry calculations.
   - `progressEvaluator.ts`: Granular student progress determination.
   - `reminderScheduler.ts`: Timing calculations for reminders.

---

## Setup & Installation

### 1. Prerequisites
- **Node.js** (v18 or newer recommended)
- **PostgreSQL** Database instance

### 2. Installation Steps
1. Clone the repository to your local machine:
   ```bash
   git clone https://github.com/RevisionDotMy-git/whatsapp-bot.git
   cd whatsapp-bot
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up your environment variables. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Modify `.env` to include your PostgreSQL connection URL, LearnDash REST API credentials, and Gemini API Key.
4. Run Prisma database migrations to create the tables in your PostgreSQL database:
   ```bash
   npx prisma db push
   ```

### 3. Running Locally
Start the server in development mode:
   ```bash
   npm run dev
   ```
On startup:
- The server will log a QR code in the console.
- Scan the QR code using your WhatsApp client ("Linked Devices") to authorize the bot.
- Once connected, the bot credentials will be saved in the local `whatsapp_session/` folder, meaning you won't need to scan it again.
- Fastify server starts listening on `http://localhost:4000`.

---

## Web API Routes

### 1. Register Workshop
- **Endpoint**: `POST /api/workshop`
- **Content-Type**: `application/json`
- **Request Body**:
  ```json
  {
    "subject": "Form 5 Chemistry Class",
    "courseId": 248,
    "meetingLink": "https://meet.google.com/xyz-pdqr-abc",
    "classDayOfWeek": 6, 
    "classTime": "10:00",
    "teacherName": "Teacher Sarah",
    "teacherPhone": "60123456789@s.whatsapp.net"
  }
  ```

### 2. Bulk-Import Student Roster
- **Endpoint**: `POST /api/workshop/:id/students/import`
- **Content-Type**: `application/json`
- **Request Body** (Roster JSON array parsed from the CSV Web UI):
  ```json
  [
    {
      "name": "Jane Doe",
      "phoneNumber": "60198765432@s.whatsapp.net",
      "learndashId": 12
    },
    {
      "name": "Alex Smith",
      "phoneNumber": "60111223344@s.whatsapp.net",
      "learndashId": 13
    }
  ]
  ```
*Note: This automatically triggers group orchestration in the background, creating the group, adding the students, promoting the teacher to admin, and sending the welcome announcement.*

### 3. LearnDash Submission Webhook
- **Endpoint**: `POST /api/webhook/submission`
- **Request Body** (Triggered from LearnDash plugin hook upon essay submission):
  ```json
  {
    "userId": 12,
    "lessonId": 101,
    "assignmentId": 8502,
    "essayText": "This is my paragraph submission response...",
    "questionTitle": "Write a summary explaining photosynthesis.",
    "teacherAnswerKey": "Photosynthesis turns light energy into chemical energy..."
  }
  ```

---

## WhatsApp Commands Reference

The bot verifies roles using the sender's phone number to protect admin functions.

### Teacher Admin Commands
- **`/homework <lesson_id>`**: Registers a new homework lesson for tracking. Sets due date to **exactly 7 days from now** (no manual date entry required).
- **`/report`**: Compiles a localized progress table (completion rates, skipped exercises, pending items) and DMs it to the teacher. (Token-saving; does not use LLM for computation).
- **`/students`**: Returns a list of all registered students and phone numbers in the class.
- **`/check <student_name>`**: Audits the homework progress logs for the specific student.

### Student Commands
- **`/homework`**: Lists all active pending homework items and their due dates.
- **`/meeting`** or **`/link`**: Returns the active Google Meet or Zoom class link for the class.
