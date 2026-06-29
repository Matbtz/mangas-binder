import fs from 'fs';
const content = fs.readFileSync('src/server/routes/api.js', 'utf8');
const match = content.match(/function chapterView\([\s\S]*?\{([\s\S]*?)\}/);
console.log(match ? match[0] : "Not found");
