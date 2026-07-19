const fs = require('fs');
const path = 'C:\\Users\\hp\\Desktop\\TEST ME\\prepium\\app.js';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  ["app.get('/cgpa', isStudent",              "app.get('/cgpa', isAuth, requirePaid, async"],
  ["app.post('/cgpa/setup', isStudent",       "app.post('/cgpa/setup', isAuth, requirePaid, async"],
  ["app.post('/cgpa/course/add', isStudent",  "app.post('/cgpa/course/add', isAuth, requirePaid, async"],
  ["app.post('/cgpa/course/edit', isStudent", "app.post('/cgpa/course/edit', isAuth, requirePaid, async"],
  ["app.post('/cgpa/course/toggle-visible/:id', isStudent", "app.post('/cgpa/course/toggle-visible/:id', isAuth, requirePaid, async"],
  ["app.post('/cgpa/course/delete/:id', isStudent", "app.post('/cgpa/course/delete/:id', isAuth, requirePaid, async"],
  ["app.post('/cgpa/reset', isStudent",       "app.post('/cgpa/reset', isAuth, requirePaid, async"],
  ["app.get('/cgpa/api/data', isStudent",     "app.get('/cgpa/api/data', isAuth, requirePaid, async"],
  ["app.post('/api/cgpa/forecast', isAuth",   "app.post('/api/cgpa/forecast', isAuth, requirePaid"],
  ["app.get('/api/cgpa/transcript', isAuth",  "app.get('/api/cgpa/transcript', isAuth, requirePaid"],
  ["app.get('/timetable', isAuth",            "app.get('/timetable', isAuth, requirePaid"],
  ["app.post('/timetable/add', isAuth",       "app.post('/timetable/add', isAuth, requirePaid"],
  ["app.post('/timetable/extract', isAuth",   "app.post('/timetable/extract', isAuth, requirePaid"],
  ["app.post('/timetable/delete/:id', isAuth","app.post('/timetable/delete/:id', isAuth, requirePaid"],
  ["app.post('/timetable/update/:id', isAuth","app.post('/timetable/update/:id', isAuth, requirePaid"],
  ["app.post('/api/timetable/update/:id', isAuth","app.post('/api/timetable/update/:id', isAuth, requirePaid"],
  ["app.post('/timetable/save-extracted', isAuth","app.post('/timetable/save-extracted', isAuth, requirePaid"],
  ["app.post('/reading-timetable/settings', isAuth",   "app.post('/reading-timetable/settings', isAuth, requirePaid"],
  ["app.post('/reading-timetable/generate', isAuth",    "app.post('/reading-timetable/generate', isAuth, requirePaid"],
  ["app.post('/reading-timetable/delete/:id', isAuth",  "app.post('/reading-timetable/delete/:id', isAuth, requirePaid"],
  ["app.post('/reading-timetable/reset', isAuth",       "app.post('/reading-timetable/reset', isAuth, requirePaid"],
  ["app.get('/history', isStudent",           "app.get('/history', isAuth, requirePaid, async"],
  ["app.get('/api/user-courses', isAuth",     "app.get('/api/user-courses', isAuth, requirePaid"],
  ["app.post('/api/user-courses/add', isAuth","app.post('/api/user-courses/add', isAuth, requirePaid"],
  ["app.post('/api/user-courses/delete/:id', isAuth","app.post('/api/user-courses/delete/:id', isAuth, requirePaid"],
  ["app.post('/api/user-courses/bulk', isAuth","app.post('/api/user-courses/bulk', isAuth, requirePaid"],
  ["app.get('/setup-test', isStudent",        "app.get('/setup-test', isAuth, async"],
  ["app.post('/start-quiz', isStudent",       "app.post('/start-quiz', isAuth, async"],
  ["app.post('/live-exam', isStudent",        "app.post('/live-exam', isAuth, async"],
  ["app.post('/submit-exam', isStudent",      "app.post('/submit-exam', isAuth, async"]
];

let replaced = 0, missing = 0;
for (const [from, to] of replacements) {
  if (content.includes(from)) {
    content = content.split(from).join(to);
    replaced++;
    console.log('OK :', from);
  } else {
    missing++;
    console.log('MISS:', from);
  }
}

fs.writeFileSync(path, content, 'utf8');
console.log(`\nReplaced ${replaced}, missing ${missing}`);
