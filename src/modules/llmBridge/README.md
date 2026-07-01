# LLM Bridge Module

This module handles integration with the Google Gemini API to analyze and grade essay submissions from students.

## Interface
`ILLMBridge`

## Methods
- `evaluateEssay(questionPrompt, referenceAnswer, studentSubmission)`: Transmits the prompt, reference answer, and student submission text to Gemini, cleans markdown wrap formatting, and returns a JSON evaluation containing the score and detailed feedback criteria.
