import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('web/app.js', 'utf8');

const volQualAdd = `
    // Volume quality logic
    const qualLabels = ['unknown', 'low', 'ok', 'high'];
    const numericQualities = chaps
      .filter(c => c.state === 'imported' || c.state === 'downloaded' || c.state === 'bindery')
      .map(c => qualLabels.indexOf(c.scanQuality || 'unknown'))
      .filter(q => q > 0)
      .sort((a,b) => a - b);

    let volQualStar = '';
    let volQualTitle = '';
    if (numericQualities.length > 0) {
      const mid = numericQualities[Math.floor((numericQualities.length - 1) / 2)];
      const lbl = qualLabels[mid];
      if (lbl === 'high') { volQualStar = ' <span style="color:#ffd700">★</span>'; volQualTitle = 'Quality: high'; }
      else if (lbl === 'ok') { volQualStar = ' <span style="color:#999">★</span>'; volQualTitle = 'Quality: ok'; }
      else if (lbl === 'low') { volQualStar = ' <span style="color:#f88">★</span>'; volQualTitle = 'Quality: low'; }
    }

    const volHead = h(\`<div class="vol-header">
      <span class="vol-chevron">▶</span>
      <span class="vol-bookmark">🔖</span>
      <strong style="font-size:15px;color:#fff;min-width:130px">\${esc(label)}</strong>
      <div class="vol-progress" data-volbar="\${esc(vk)}" style="margin-left:auto">\${progressBar(owned, total)}</div>
      <div class="vol-pkg-slot" style="margin-right:4px"></div>
      <span class="progress-badge \${isComplete?'complete':owned>0?'partial':''}" data-volbadge="\${esc(vk)}" title="\${volQualTitle}">\${owned}/\${total}\${volQualStar}</span>
      <div class="row vol-acts" style="gap:6px;margin-left:12px"></div>
    </div>\`);
`;

content = content.replace(/    const volHead = h\(\`<div class="vol-header">\n      <span class="vol-chevron">▶<\/span>\n      <span class="vol-bookmark">🔖<\/span>\n      <strong style="font-size:15px;color:#fff;min-width:130px">\$\{esc\(label\)\}<\/strong>\n      <div class="vol-progress" data-volbar="\$\{esc\(vk\)\}" style="margin-left:auto">\$\{progressBar\(owned, total\)\}<\/div>\n      <div class="vol-pkg-slot" style="margin-right:4px"><\/div>\n      <span class="progress-badge \$\{isComplete\?'complete':owned>0\?'partial':''\}" data-volbadge="\$\{esc\(vk\)\}">\$\{owned\}\/\$\{total\}<\/span>\n      <div class="row vol-acts" style="gap:6px;margin-left:12px"><\/div>\n    <\/div>\`\);/, volQualAdd.trim());

writeFileSync('web/app.js', content);
