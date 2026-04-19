const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();
(async () => {
  const paperId = 'cmo5g5dxw000d7nwv1etx8y44';
  const q10 = await prisma.examQuestion.findFirst({
    where: { examPaperId: paperId, questionNum: '10' },
    select: {
      id: true, questionNum: true, answer: true, studentAnswer: true, markingNotes: true,
      marksAwarded: true, marksAvailable: true,
      transcribedSubparts: true, syllabusTopic: true, sourceQuestionId: true
    }
  });
  console.log('Q10:');
  console.log('  marks:', q10.marksAwarded, '/', q10.marksAvailable);
  console.log('  studentAnswer:', q10.studentAnswer);
  console.log('  markingNotes:', q10.markingNotes);
  console.log('  answer:', q10.answer);
  console.log('  subparts:', JSON.stringify(q10.transcribedSubparts?.map(s => ({ label: s.label, text: s.text?.slice(0, 80), hasAnswer: !!s.answer })), null, 2));
  
  // Check submission folder
  const subDir = path.join('C:/temp/yuna-submissions', paperId);
  if (fs.existsSync(subDir)) {
    const files = fs.readdirSync(subDir).filter(f => f.includes('page_9') || f.includes('page_10'));
    console.log('\nSubmission files for Q10 (page_9 — 0-indexed):');
    for (const f of files) {
      const stat = fs.statSync(path.join(subDir, f));
      console.log(`  ${f}: ${stat.size} bytes`);
    }
  } else {
    console.log('\n(No local submission dir found; production only)');
  }
})().finally(() => process.exit(0));
