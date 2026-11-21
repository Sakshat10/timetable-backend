import 'dotenv/config';
import prisma from './dist/config/database.js';

async function getTestData() {
  try {
    // Get latest school
    const school = await prisma.school.findFirst({
      orderBy: { createdAt: 'desc' }
    });
    
    if (!school) {
      console.log('NO_SCHOOL');
      return;
    }
    
    // Get latest admin for that school
    const admin = await prisma.admin.findFirst({
      where: { schoolId: school.id },
      orderBy: { createdAt: 'desc' }
    });
    
    console.log(JSON.stringify({
      school: {
        id: school.id,
        name: school.name,
        code: school.code
      },
      admin: admin ? {
        id: admin.id,
        email: admin.email,
        name: admin.name
      } : null
    }, null, 2));
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

getTestData();
