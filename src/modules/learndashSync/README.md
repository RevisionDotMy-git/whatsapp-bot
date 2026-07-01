# LearnDash Sync Module

This module manages all WordPress / LearnDash API queries, user verification, caching of courses/lessons locally, and course categorization.

## Design
This module is strictly decoupled from the messaging interface (no WhatsApp/Baileys or Telegram imports). It can be directly shared or copied between the WhatsApp and Telegram bots.

## Interface
`ILearnDashSync`

## Methods
- `authenticate(): Promise<string>`: Authenticates connection details (Basic Auth support).
- `getStudentCourseProgress(userId, courseId)`: Fetches progress data for a student user on WordPress.
- `getAssignmentSubmission(userId, lessonId)`: Retrieves specific assignment submissions.
- `submitGradeAndComment(assignmentId, score, comment)`: Updates assignment score/comment.
- `verifyUserId(userId)`: Verifies if a WordPress user ID exists.
- `syncAllWithLearnDash()`: Performs a parallel sync of all courses and lessons to compile `data/learndash_cache.json`.
