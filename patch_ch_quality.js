import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('web/app.js', 'utf8');

const chQualAdd = `
      let qualHtml = '';
      if (ownedState && c.scanQuality) {
        if (c.scanQuality === 'high') qualHtml = \` <span style="color:#ffd700;font-size:12px;margin-left:4px" title="Quality: high\${c.minPageWidth ? \` (min page width: \${c.minPageWidth.toLocaleString()}px)\` : ''}">★</span>\`;
        else if (c.scanQuality === 'ok') qualHtml = \` <span style="color:#999;font-size:12px;margin-left:4px" title="Quality: ok\${c.minPageWidth ? \` (min page width: \${c.minPageWidth.toLocaleString()}px)\` : ''}">★</span>\`;
        else if (c.scanQuality === 'low') qualHtml = \` <span style="color:#f88;font-size:12px;margin-left:4px" title="Quality: low\${c.minPageWidth ? \` (min page width: \${c.minPageWidth.toLocaleString()}px)\` : ''}">★</span>\`;
        else qualHtml = ' <span style="color:#555;font-size:12px;margin-left:4px" title="Quality: unknown">–</span>';
      } else if (!ownedState) {
        qualHtml = ' <span style="color:#555;font-size:12px;margin-left:4px" title="Quality: unknown">–</span>';
      }

      const tr = h(\`<tr data-ch="\${c.id}">
        <td style="color:var(--muted);font-weight:600">\${esc(c.number)}</td>
        <td>
          <span style="display:inline-block;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;vertical-align:middle" title="\${esc(c.title||\`Chapter \${c.number}\`)}">\${esc(c.title||\`Chapter \${c.number}\`)}</span>
          \${langBadge}
        </td>
        <td style="color:var(--muted);font-size:12px">\${esc(dateStr)}</td>
        <td class="st-cell">\${chapterStatusHTML(c)}\${qualHtml}</td>
        <td class="act-cell" style="display:flex;justify-content:flex-end;align-items:center;gap:6px"></td>
      </tr>\`);
`;

content = content.replace(/      const tr = h\(\`<tr data-ch="\$\{c\.id\}">\n        <td style="color:var\(--muted\);font-weight:600">\$\{esc\(c\.number\)\}<\/td>\n        <td>\n          <span style="display:inline-block;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;vertical-align:middle" title="\$\{esc\(c\.title\|\|\`Chapter \$\{c\.number\}\`\)\}">\$\{esc\(c\.title\|\|\`Chapter \$\{c\.number\}\`\)\}<\/span>\n          \$\{langBadge\}\n        <\/td>\n        <td style="color:var\(--muted\);font-size:12px">\$\{esc\(dateStr\)\}<\/td>\n        <td class="st-cell">\$\{chapterStatusHTML\(c\)\}<\/td>\n        <td class="act-cell" style="display:flex;justify-content:flex-end;align-items:center;gap:6px"><\/td>\n      <\/tr>\`\);/, chQualAdd.trim());

writeFileSync('web/app.js', content);
