---
name: whatsapp-bot-manager
description: Manage classes, homework, student onboarding, reports, and send announcements for the WhatsApp Online Revision Bot using the CLI tool.
---

# WhatsApp Bot Manager Skill

This skill allows an autonomous agent (like OpenClaw) to manage classes, assign homework, check student enrollment, generate progress reports, trigger cache syncs, and send announcements via the WhatsApp Bot's CLI tool.

## Prerequisites
- The Fastify API server must be running on `http://localhost:4000`. If it is running on a different URL/port, set the `API_BASE` environment variable.
- Execute commands using `npx tsx src/tools/openclaw-cli.ts <action> [arguments]`.

---

## Action Guide

### 1. Synchronization
- **Sync LearnDash cache**:
  ```bash
  npx tsx src/tools/openclaw-cli.ts sync
  ```

### 2. Class CRUD
- **List all classes**:
  ```bash
  npx tsx src/tools/openclaw-cli.ts class-list
  ```
- **Create a new class**:
  `npx tsx src/tools/openclaw-cli.ts class-create <subject> <courseId> <day> <time> <teacherPhone> <teacherName>`
  - Day is a number: `0` (Sunday), `1` (Monday) ... `6` (Saturday).
  - Time is in `"HH:MM"` format.
  - *Example:*
    ```bash
    npx tsx src/tools/openclaw-cli.ts class-create "Form 5 Physics Advanced" 101 1 "20:00" "60122082435" "Cikgu Kwee"
    ```
- **Delete a class**:
  ```bash
  npx tsx src/tools/openclaw-cli.ts class-delete <workshopId>
  ```

### 3. Homework Management
- **Assign homework**:
  `npx tsx src/tools/openclaw-cli.ts homework-assign <workshopId> <lessonId> [dueDateText]`
  - `dueDateText` can be relative (`tomorrow`, `next week`, `3 days`) or absolute (`2026-06-30`).
  - *Example:*
    ```bash
    npx tsx src/tools/openclaw-cli.ts homework-assign "workshop-123" 19930 "next week"
    ```
- **List class homeworks**:
  ```bash
  npx tsx src/tools/openclaw-cli.ts homework-list <workshopId>
  ```
- **Delete homework**:
  ```bash
  npx tsx src/tools/openclaw-cli.ts homework-delete <workshopId> <lessonId>
  ```

### 4. Student & Teacher Management
- **Invite student/teacher**:
  `npx tsx src/tools/openclaw-cli.ts student-invite <student|teacher> <phone> <name>`
  - Triggers profile onboarding DM instructions to the student phone number.
  - *Example:*
    ```bash
    npx tsx src/tools/openclaw-cli.ts student-invite student "60198765432" "John Doe"
    ```
- **Enroll student in a class**:
  `npx tsx src/tools/openclaw-cli.ts student-add <studentPhone> <workshopId>`
- **List class students**:
  ```bash
  npx tsx src/tools/openclaw-cli.ts student-list <workshopId>
  ```
- **Remove student/teacher**:
  `npx tsx src/tools/openclaw-cli.ts student-remove <student|teacher> <phone> [subject]`
  - If `subject` is omitted, removes the user globally. If provided, unenrolls the student from that specific workshop.

### 5. Progress Reports & Announcements
- **Generate progress report**:
  ```bash
  npx tsx src/tools/openclaw-cli.ts report <workshopId>
  ```
- **Send custom WhatsApp message/announcement**:
  `npx tsx src/tools/openclaw-cli.ts send-message <phone_or_jid> <message_text>`
  - *Example:*
    ```bash
    npx tsx src/tools/openclaw-cli.ts send-message "60198765432" "Remember to complete your Physics homework by tomorrow!"
    ```
