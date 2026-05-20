const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        created_at: true,
        provider: { select: { id: true, company_name: true } },
        creator: { select: { id: true, display_name: true } },
        customer: { select: { id: true } },
      },
      orderBy: { created_at: 'asc' },
    });
    console.log(JSON.stringify(users, null, 2));
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    await prisma.$disconnect();
  }
})();
