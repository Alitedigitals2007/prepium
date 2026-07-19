const fs = require('fs');
const c = fs.readFileSync('C:\\Users\\hp\\Desktop\\TEST ME\\prepium\\app.js', 'utf8');
console.log('has import-timetable isAuth:', c.includes("app.post('/api/study/import-timetable', isAuth"));
console.log('length:', c.length);
console.log('first 200:', JSON.stringify(c.slice(0,200)));
