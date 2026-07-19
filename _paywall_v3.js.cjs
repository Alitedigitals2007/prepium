const fs = require('fs');
const path = 'C:\\Users\\hp\\Desktop\\TEST ME\\prepium\\app.js';
let content = fs.readFileSync(path, 'utf8');

// Use regex with capture groups to insert ", requirePaid" after "isAuth"
const replacements = [
  /app\.post\('\/api\/study\/import-timetable', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/topics', isAuth(?=, async)/,
  /app\.delete\('\/api\/study\/topics\/:id', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/generate-topics', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/generate-subtopics', isAuth(?=, async)/,
  /app\.put\('\/api\/study\/subtopics\/:id\/accept', isAuth(?=, async)/,
  /app\.put\('\/api\/study\/subtopics\/:id', isAuth(?=, async)/,
  /app\.delete\('\/api\/study\/subtopics\/:id', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/sessions', isAuth(?=, async)/,
  /app\.put\('\/api\/study\/sessions\/:id\/end', isAuth(?=, async)/,
  /app\.put\('\/api\/study\/sessions\/:id\/notes', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/chat', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/quiz\/generate', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/quiz\/submit', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/flashcards\/generate', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/flashcards\/delete\/:id', isAuth(?=, async)/,
  /app\.post\('\/api\/study\/cgpa-sync', isAuth(?=, async)/
];

let count = 0;
for (const re of replacements) {
  if (re.test(content)) {
    content = content.replace(re, (m) => m.replace('isAuth', 'isAuth, requirePaid'));
    count++;
    console.log('OK:', re.source);
  } else {
    console.log('MISS:', re.source);
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log('\nDone. Replaced', count);
