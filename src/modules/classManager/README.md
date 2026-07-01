# Class Manager Module

This module manages registered workshop classes, teacher allocations, student enrollments, and space-resilient parsing logic for creating new classes.

## Interface
`IClassManager`

## Methods
- `listClasses()`: Returns all registered workshops along with their assigned teachers.
- `createClass(params)`: Upserts the class teacher, generates a randomized Google Meet link, and registers the workshop.
- `deleteClass(subjectOrId)`: Removes a workshop class (automatically cascades deletion of student enrollments and homework logs).
- `enrollStudent(workshopId, studentJid, name, learndashId)`: Registers a student and enrolls them into a class. Automatically initializes progress logs for any outstanding homework assigned to that class.
- `unenrollStudent(studentJid, subject)`: Removes a student from a specific class.
- `removeUserGlobally(role, jid)`: Removes a teacher or student entirely from the database. Prevents teacher removal if they are currently assigned to active classes.
- `parseClassCreationArgs(args)`: Scans space-separated parameters, using courseId and schedule cues to correctly segment the subject name and teacher name.
