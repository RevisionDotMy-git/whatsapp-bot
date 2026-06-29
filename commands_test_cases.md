# WhatsApp Bot Commands Test Cases

This document logs the test scenarios, statuses, improvements, and comments for all available WhatsApp bot commands.

| Command | Test Scenario | Test Status | Improvement | Comment |
|---|---|---|---|---|
| **/help** | Student `/help` (in workshop or DM) | pass | - | Correctly returns student command guide. |
| **/help** | Teacher `/help` | pass | - | Correctly returns teacher command guide. |
| **/invite** | `/invite student <phone> <name>` | pass | - | Enrolls student with negative placeholder ID and DMs onboarding instructions. |
| **/invite** | `/invite teacher <phone> <name>` | pass | - | Registers teacher in the database. |
| **/invite** | Role conflict recovery (invite registered student as teacher or vice-versa) | pass | - | Blocks action and suggests appropriate recovery. |
| **/add** | `/add <phone> <subject>` | pass | - | Enrolls student. Falls back to invite link DM if direct add fails due to privacy. |
| **/add** | Subject not available recovery | pass | - | Lists all available class subjects in the DB if requested subject is not found. |
| **/profile** | `/profile <phone> name <new_name>` | pass | - | Correctly updates student's name in the database. |
| **/profile** | `/profile <phone> id <learndash_id>` | pass | - | Verifies ID with WordPress and links to student profile. |
| **/profile** | Duplicate LearnDash ID linking | pass | - | Warns and suggests unlinking the other student first. |
| **/groups** | `/groups` | pass | - | Lists all WhatsApp group chats where the bot is currently participating. |
| **/homework** | `/homework <lesson_id>` | pass | - | Assigns lesson to workshop, sets default 7-day due date, and notifies group. |
| **/homework** | `/homework <lesson_id | query> [due_date]` | pass | - | Resolves suffix due date (e.g. `due tomorrow`) and search-based lesson ID from cache. |
| **/homework** | `/homework delete <lesson_id>` | pass | - | Deletes the assignment and cascade deletes associated progress logs. |
| **/homework** | Student `/homework` / `/homework check` | pass | - | Lists student's personal pending homework. |
| **/homework** | Student `/homework done` | pass | - | Marks oldest pending homework as completed and saves completion. |
| **/meeting** | Student `/meeting` | pass | - | Displays meeting link for the class workshop. |
| **/meeting** | Teacher `/meeting [create] [<subject>] [<link>]` | pass | - | Updates link, generates default Google Meet link if link is omitted, notifies group. |
| **/link** | Student `/link <learndash_id>` | pass | - | Directly links student to WordPress ID after validation. |
| **/unlink** | Student `/unlink` / Teacher `/unlink <phone>` | pass | - | Resets student's LearnDash ID to negative placeholder. |
| **/remove** | `/remove student <phone> [<subject>]` | pass | - | Unenrolls student from class or deletes globally (cascades). |
| **/remove** | `/remove teacher <phone>` | pass | - | Deletes teacher globally if not assigned to active classes. |
| **/report** | `/report [<group_name>] [<phone_number>]` | pass | - | Compiles group or student progress report and sends to teacher's private DM. |
| **/students** | `/students` | pass | - | Lists all students enrolled in the workshop. |
| **/check** | `/check <student_name>` | pass | - | Audits progress of a specific student by name. |
| **/class** | `/class list` | pass | - | Lists all registered classes, course IDs, teachers, and meeting links. |
| **/class** | `/class create <subject> <courseId> <day> <time> <teacher_phone> <teacher_name>` | pass | - | Space-resilient parsing, registers class/teacher, generates Google Meet link. |
| **/class** | `/class delete <subject_or_id>` | pass | - | Deletes class, cascade deleting enrollments and assignments. |
