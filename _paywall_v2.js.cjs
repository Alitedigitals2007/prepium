const fs = require('fs');
const path = 'C:\\Users\\hp\\Desktop\\TEST ME\\prepium\\app.js';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  "app.post('/api/study/import-timetable', isAuth",
  "app.post('/api/study/topics', isAuth",
  "app.delete('/api/study/topics/:id', isAuth",
  "app.post('/api/study/generate-topics', isAuth",
  "app.post('/api/study/generate-subtopics', isAuth",
  "app.put('/api/study/subtopics/:id/accept', isAuth",
  "app.put('/api/study/subtopics/:id', isAuth",
  "app.delete('/api/study/subtopics/:id', isAuth",
  "app.post('/api/study/sessions', isAuth",
  "app.put('/api/study/sessions/:id/end', isAuth",
  "app.put('/api/study/sessions/:id/notes', isAuth",
  "app.post('/api/study/chat', isAuth",
  "app.post('/api/study/quiz/generate', isAuth",
  "app.post('/api/study/quiz/submit', isAuth",
  "app.post('/api/study/flashcards/generate', isAuth",
  "app.post('/api/study/flashcards/delete/:id', isAuth",
  "app.post('/api/study/cgpa-sync', isAuth"
];

let count = 0;
for (const oldStr of replacements) {
  if (content.includes(oldStr)) {
    const newStr = oldStr.replace(', isAuth,', ', isAuth, requirePaid,');
    const before = content.length;
    content = content.split(oldStr).join(newStr);
    if (content.length !== before) {
      count++;
      console.log('OK: ' + oldStr);
    }
  } else {
    console.log('MISS: ' + oldStr);
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log('\nDone. Replaced ' + count + ' routes.');
