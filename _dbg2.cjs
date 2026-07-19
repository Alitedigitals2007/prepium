const fs = require('fs');
const path = 'C:\\Users\\hp\\Desktop\\TEST ME\\prepium\\app.js';
let content = fs.readFileSync(path, 'utf8');

const oldStr = "app.post('/api/study/import-timetable', isAuth";
const newStr = "app.post('/api/study/import-timetable', isAuth, requirePaid";
console.log('matched:', content.includes(oldStr));
content = content.split(oldStr).join(newStr);
console.log('after replace still matches old?:', content.includes(oldStr));
console.log('after replace matches new?:', content.includes(newStr));
fs.writeFileSync(path, content, 'utf8');
console.log('saved');
