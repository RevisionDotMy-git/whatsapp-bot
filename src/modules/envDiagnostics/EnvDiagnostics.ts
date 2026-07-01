import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { IEnvDiagnostics } from './IEnvDiagnostics.js';

const envSchema = z.object({
  PORT: z.string().transform((val) => parseInt(val, 10)).default('4000'),
  DATABASE_URL: z.string().url(),
  LEARNDASH_BASE_URL: z.string().url(),
  LEARNDASH_JWT_USERNAME: z.string(),
  LEARNDASH_JWT_PASSWORD: z.string(),
  GEMINI_API_KEY: z.string(),
  BOT_PHONE_NUMBER: z.string().optional(),
});

export class EnvDiagnostics implements IEnvDiagnostics {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async validateEnv(): Promise<boolean> {
    console.log('🔍 Diagnostics: Validating environment variables...');
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('❌ Diagnostics Error: Environment validation failed:');
      console.error(JSON.stringify(result.error.format(), null, 2));
      return false;
    }
    console.log('✅ Diagnostics: Environment variables validated successfully.');
    return true;
  }

  async testDbConnection(): Promise<boolean> {
    console.log('🔍 Diagnostics: Testing database connection...');
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      console.log('✅ Diagnostics: Database connection successful.');
      return true;
    } catch (err: any) {
      console.error('❌ Diagnostics Error: Database connection failed.');
      console.error(`Message: ${err.message}`);
      console.log('\n💡 Troubleshooting Tip for Hostinger VPS:');
      console.log('👉 PostgreSQL service might be stopped. Run:');
      console.log('   sudo systemctl start postgresql');
      console.log('👉 Or check your DATABASE_URL in the .env file.\n');
      return false;
    }
  }

  async testLearnDashConnection(): Promise<boolean> {
    console.log('🔍 Diagnostics: Testing LearnDash API reachability...');
    const baseUrl = process.env.LEARNDASH_BASE_URL;
    if (!baseUrl) return false;

    try {
      const response = await fetch(new URL('/wp-json/wp/v2/users/me', baseUrl).toString(), {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${process.env.LEARNDASH_JWT_USERNAME}:${process.env.LEARNDASH_JWT_PASSWORD}`).toString('base64')}`
        }
      });

      if (response.status === 200) {
        console.log('✅ Diagnostics: LearnDash API authentication successful.');
        return true;
      } else {
        console.warn(`⚠️ Diagnostics Warning: LearnDash API returned status ${response.status}. Authentication might be invalid.`);
        return false;
      }
    } catch (err: any) {
      console.error('❌ Diagnostics Error: LearnDash API is unreachable.');
      console.error(`Message: ${err.message}`);
      console.log('\n💡 Troubleshooting Tip:');
      console.log(`👉 Verify that your VPS can connect to: ${baseUrl}`);
      console.log('👉 Check your server internet connection/DNS resolution.\n');
      return false;
    }
  }

  async testDirectories(): Promise<boolean> {
    console.log('🔍 Diagnostics: Verifying critical directories...');
    const dirs = [
      path.join(process.cwd(), 'data'),
      path.join(process.cwd(), 'whatsapp_session')
    ];

    let allWritable = true;
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // Test write access
        const testFile = path.join(dir, '.write-test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        console.log(`✅ Diagnostics: Directory "${path.basename(dir)}" is readable and writable.`);
      } catch (err: any) {
        console.error(`❌ Diagnostics Error: Directory "${dir}" is not writable: ${err.message}`);
        allWritable = false;
      }
    }
    return allWritable;
  }

  async runAllChecks(): Promise<boolean> {
    console.log('\n=================== 🩺 STARTING BOT DIAGNOSTICS ===================');
    const envOk = await this.validateEnv();
    const dbOk = await this.testDbConnection();
    const dirsOk = await this.testDirectories();
    const ldOk = await this.testLearnDashConnection();
    console.log('=================== 🩺 DIAGNOSTICS COMPLETED ===================\n');

    if (!envOk || !dbOk || !dirsOk) {
      console.error('❌ Diagnostics: Critical connection or config failures detected. Startup aborted.');
      return false;
    }
    
    if (!ldOk) {
      console.warn('⚠️ Diagnostics: LearnDash connection check failed, but proceeding anyway.');
    }
    
    return true;
  }
}
