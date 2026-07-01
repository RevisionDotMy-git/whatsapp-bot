# Homework Manager Module

This module manages all homework tasks assigned to workshop classes, handles completion status tracking, and intercepts/analyzes custom student assignments (like PDFs, docx files, or Google Drive links).

## Interface
`IHomeworkManager`

## Methods
- `assignHomework(workshopId, lessonId, title, dueDate)`: Registers/updates homework tasks and sets up progress logs.
- `deleteHomework(workshopId, lessonId)`: Unassigns/deletes homework tasks.
- `listHomeworks(workshopId)`: Retrieves all registered assignments for a class.
- `markHomeworkDone(studentJid, searchSenderJids)`: Auto-detects and completes the oldest pending assignment for a student.
- `listPendingHomeworks(searchSenderJids)`: Returns all outstanding assignments for a student.
- `detectCustomHomework(msg, workshopId, enrolledStudentJids)`: Scans message content for documents or Google Drive links, auto-generates custom homework records, and sets their due date boundaries.
