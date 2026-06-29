import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('web/app.js', 'utf8');

const actAdd = `
          const qualLabels = ['unknown', 'low', 'ok', 'high'];
          let volQualHtml = '';
          if (c.scanQualities && c.scanQualities.length > 0) {
            const numQ = c.scanQualities.map(q => qualLabels.indexOf(q)).sort((a,b) => a - b);
            const mid = numQ[Math.floor((numQ.length - 1) / 2)];
            const lbl = qualLabels[mid];
            if (lbl === 'high') volQualHtml = ' | Quality: <span style="color:#ffd700">★</span>';
            else if (lbl === 'ok') volQualHtml = ' | Quality: <span style="color:#999">★</span>';
            else if (lbl === 'low') volQualHtml = ' | Quality: <span style="color:#f88">★</span>';
          }

          const row = h(\`<div class="q-row" style="cursor:pointer;user-select:none">
            \${qThumb(c)}
            <div class="q-main">
              <div class="q-title"><strong>\${esc(c.seriesTitle)}</strong></div>
              <div class="q-sub">\${esc(c.fileName)} · <span class="muted">Packaged: \${esc(formatParis(c.packagedAt))} · \${(c.size / (1024 * 1024)).toFixed(2)} MB\${volQualHtml}</span></div>
            </div>
            <div class="q-status" style="margin-right:12px"><span class="status-badge ok">📦 Packaged</span></div>
            <div class="q-actions" style="margin-right:12px; display:flex; gap:8px;"></div>
            <div style="font-size:16px;color:var(--muted);width:24px;text-align:center">\${isExpanded ? '▼' : '▶'}</div>
          </div>\`);
`;

content = content.replace(/          const row = h\(\`<div class="q-row" style="cursor:pointer;user-select:none">\n            \$\{qThumb\(c\)\}\n            <div class="q-main">\n              <div class="q-title"><strong>\$\{esc\(c\.seriesTitle\)\}<\/strong><\/div>\n              <div class="q-sub">\$\{esc\(c\.fileName\)\} · <span class="muted">Packaged: \$\{esc\(formatParis\(c\.packagedAt\)\)\} · \$\{\(c\.size \/ \(1024 \* 1024\)\)\.toFixed\(2\)\} MB<\/span><\/div>\n            <\/div>\n            <div class="q-status" style="margin-right:12px"><span class="status-badge ok">📦 Packaged<\/span><\/div>\n            <div class="q-actions" style="margin-right:12px; display:flex; gap:8px;"><\/div>\n            <div style="font-size:16px;color:var\(--muted\);width:24px;text-align:center">\$\{isExpanded \? '▼' : '▶'\}<\/div>\n          <\/div>\`\);/, actAdd.trim());

writeFileSync('web/app.js', content);
