import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/server/views.js', 'utf8');

const chapterViewAdd = `
    startedAt: row.started_at ?? null,
    scanQuality: row.scan_quality ?? 'unknown',
    minPageWidth: row.min_page_width ?? null,
`;

content = content.replace(/    startedAt: row\.started_at \?\? null,/, chapterViewAdd.trim());

writeFileSync('src/server/views.js', content);
