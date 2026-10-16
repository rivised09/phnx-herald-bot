const { PrismaClient } = require('../generated/roster-client');

const prisma = new PrismaClient();

module.exports = prisma;
