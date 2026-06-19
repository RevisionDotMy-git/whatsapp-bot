import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  
  DATABASE_URL: process.env.DATABASE_URL || '',
  
  LEARNDASH: {
    BASE_URL: process.env.LEARNDASH_BASE_URL || '',
    JWT_USERNAME: process.env.LEARNDASH_JWT_USERNAME || '',
    JWT_PASSWORD: process.env.LEARNDASH_JWT_PASSWORD || '',
  },
  
  GEMINI: {
    API_KEY: process.env.GEMINI_API_KEY || '',
    MODEL_NAME: 'gemini-2.5-flash',
  },
  
  BOT: {
    PHONE_NUMBER: process.env.BOT_PHONE_NUMBER || '',
    // Expiry period for homework when created (default 7 days)
    HOMEWORK_EXPIRY_DAYS: 7,
  },
  
  REMINDERS: {
    // Number of days before the class to trigger the first reminder
    FIRST_REMINDER_DAYS: 3,
    // Number of days before the class to trigger the final reminder
    FINAL_REMINDER_DAYS: 1,
  }
};
