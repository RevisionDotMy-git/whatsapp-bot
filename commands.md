 # Commands Reference

 This document lists available bot commands with concise details for each command: description, roles, accessibility, arguments, examples, and validation notes.

 ## Quick Index

 | Command | Roles | Accessibility | Args |
 |---|---|---|---|
 | `/help` | teacher, student | group, private | - |
 | `/invite` | teacher | group, private | `student|teacher <phone> <name>` |
 | `/add` | teacher | group, private | `<phone> <subject>` |
 | `/profile` | teacher | group, private | `<phone> name|id <value>` |
 | `/groups` | teacher | group, private | - |
 | `/homework` | teacher, student | group, private | `Teacher: <lesson_id>  
 Student: check|done` |
 | `/meeting` | teacher, student | group, private | - |
 | `/link` | teacher, student | group, private | `[<learndash_id>]` |
 | `/unlink` | teacher, student | group, private | `Teacher: <phone>  
 Student: none` |
 | `/remove` | teacher | group, private | `student|teacher <phone> [<subject>]` |
 | `/report` | teacher | group, private | - |
 | `/students` | teacher | group, private | - |
 | `/check` | teacher | group, private | `<student_name>` |

 ---

 ## Command Details

 ### /help
 - Description: Displays the command guide customized to your role.
 - Roles: `teacher`, `student`
 - Accessibility: `group`, `private`
 - Example:

 ```
 /help
 ```

 ### /invite
 - Description: Registers a new teacher or student and sends onboarding instructions.
 - Roles: `teacher`
 - Accessibility: `group`, `private`
 - Args: `student|teacher <phone> <name>`
 - Example:

 ```
 /invite student 60123456789 John Doe
 ```
 - Validation notes:
   - Requires 3 arguments: role, phone, name.
   - First argument must be `student` or `teacher`.

 ### /add
 - Description: Enrolls an existing student in a class/workshop.
 - Roles: `teacher`
 - Accessibility: `group`, `private`
 - Args: `<phone> <subject>`
 - Example:

 ```
 /add 60123456789 SPM Physics
 ```
 - Validation notes: phone and subject required.

 ### /profile
 - Description: Updates a student's name or LearnDash User ID.
 - Roles: `teacher`
 - Accessibility: `group`, `private`
 - Args: `<phone> name|id <value>`
 - Example:

 ```
 /profile 60123456789 id 12345
 ```
 - Validation notes:
   - Requires 3 arguments.
   - Second argument must be `name` or `id`.

 ### /groups
 - Description: Lists all WhatsApp groups the bot is participating in.
 - Roles: `teacher`
 - Accessibility: `group`, `private`
 - Example:

 ```
 /groups
 ```

 ### /homework
 - Description: Teachers assign lessons; students list or mark homework.
 - Roles: `teacher`, `student`
 - Accessibility: `group`, `private`
 - Args:
   - Teacher: `<lesson_id>` to assign a lesson.
   - Student: `check` to list pending or `done` to mark complete (no args also lists).
 - Examples:

 ```
 Teacher: /homework 9999
 Student: /homework check
 Student: /homework done
 ```
 - Authorization rules:
   - Teachers can always run `/homework <lesson_id>`.
   - Students may run `/homework`, `/homework check`, or `/homework done` only.

 ### /meeting
 - Description: Displays the meeting link for the class.
 - Roles: `teacher`, `student`
 - Accessibility: `group`, `private`
 - Example:

 ```
 /meeting
 ```

 ### /link
 - Description: Shows linking instructions or links a LearnDash User ID to your phone.
 - Roles: `teacher`, `student`
 - Accessibility: `group`, `private`
 - Args: optional `[<learndash_id>]`
 - Examples:

 ```
 /link
 /link 12345
 ```

 ### /unlink
 - Description: Unlinks a LearnDash User ID from a phone number.
 - Roles: `teacher`, `student`
 - Accessibility: `group`, `private`
 - Args: `Teacher: <phone>` or `Student: no args`
 - Examples:

 ```
 Teacher: /unlink 60123456789
 Student: /unlink
 ```

 ### /remove
 - Description: Deletes a user globally or unenrolls a student from a workshop.
   - For global student removal, if they have active class enrollments, the bot will display a list of classes and request confirmation.
   - Deleting or unenrolling a student automatically kicks them from the corresponding WhatsApp group(s).
 - Roles: `teacher`
 - Accessibility: `group`, `private`
 - Args: `student|teacher <phone> [<subject>|confirm]`
 - Examples:

 ```
 /remove student 60123456789
 /remove student 60123456789 confirm
 /remove student 60123456789 SPM Physics
 /remove teacher 60123456789
 ```
 - Validation notes:
   - Requires at least 2 arguments.
   - First argument must be `student` or `teacher`.

 ### /report
 - Description: Compiles and sends the workshop class progress report.
 - Roles: `teacher`
 - Accessibility: `group`, `private`
 - Example:

 ```
 /report
 ```

 ### /students
 - Description: Lists students.
   - In a **group chat** (or workshop context), lists only the students enrolled in that specific class.
   - In a **private DM**:
     - For **Admins**, lists all registered students globally.
     - For **Teachers**, lists all unique students enrolled across any of their classes.
 - Roles: `teacher`
 - Accessibility: `group`, `private`
 - Example:

 ```
 /students
 ```

 ### /check
 - Description: Checks progress of a specific student by name.
 - Roles: `teacher`
 - Accessibility: `group`, `private`
 - Args: `<student_name>`
 - Example:

 ```
 /check John
 ```
 - Validation notes: student name required.

 ---

 If you'd like, I can also:
 - convert this into a JSON or YAML reference for programmatic use,
 - add a short section with common error messages and suggested fixes.

