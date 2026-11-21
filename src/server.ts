// School Timetable Backend — Module 5 test run
import 'dotenv/config';
import { buildApp } from './app.js';
import prisma from './config/database.js';
import { createGenerationRunnerFromEnv } from './modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './modules/timetable-generation/timetable-generation.runner-handle.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// The in-process generation runner (null when GENERATION_RUNNER_ENABLED=false: an API-only instance that only queues runs).
let runner: ReturnType<typeof createGenerationRunnerFromEnv> = null;

async function start() {
  try {
    // Test database connection
    await prisma.$connect();
    console.log('✓ Database connected');

    // Build and start the server
    const app = await buildApp();

    await app.listen({ port: PORT, host: HOST });
    console.log(`✓ Server listening on http://${HOST}:${PORT}`);

    runner = createGenerationRunnerFromEnv(prisma);
    if (runner) {
      registerGenerationRunner(runner);
      runner.start();
      console.log('✓ Timetable generation runner started');
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown. Running generations are put back in the queue (no attempt consumed) so another runner continues them.
async function stopRunner(): Promise<void> {
  if (!runner) return;
  registerGenerationRunner(null);
  try {
    await runner.stop(20);
  } catch (error) {
    console.error('Generation runner did not stop cleanly:', error instanceof Error ? error.message : 'unknown error');
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await stopRunner();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  await stopRunner();
  await prisma.$disconnect();
  process.exit(0);
});

start();
