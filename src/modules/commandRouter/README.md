# Command Router Module

This module checks user roles, validates parameters against the command registry, handles the teacher command deletion UI/UX logic, and routes valid commands to the proper submodules for execution.

## Interface
`ICommandRouter`

## Methods
- `executeCommand(msg, senderRole, workshopId)`: Parses input text, checks authorization, and routes to appropriate managers (`ClassManager`, `HomeworkManager`, etc.). Returns a `CommandExecutionResult` detailing what to reply, whether to delete the sender's message, and whether it's an announcement message.
