const fs = require('fs');
const c = fs.readFileSync('C:\\Users\\hp\\Desktop\\TEST ME\\prepium\\app.js', 'utf8');
const idx = c.indexOf("app.get('/cgpa");
console.log('found?', idx);
if (idx >= 0) console.log('snippet:', JSON.stringify(c.slice(idx, idx + 40)));
