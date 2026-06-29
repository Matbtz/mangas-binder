import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('web/app.js', 'utf8');

const providerReplaceSearch = `  const pc = h('<div class="card"><h2>Sources</h2></div>');
  for (const p of providers) {
    const wrap = h('<div style="border-top:1px solid #2a2a2a;padding:10px 0"></div>');
    const row = h(\`<div class="row" style="justify-content:space-between"><div><strong>\${esc(p.label)}</strong>
      <span class="pill">\${esc(p.mediaType)}</span>
      <span class="pill \${p.capabilities.download||p.capabilities.archive?'acc':''}">\${capLabel(p.capabilities)}</span></div></div>\`);
    const btns = h('<div class="row" style="gap:6px;align-items:center"></div>');
    const status = h('<span class="muted" style="font-size:12px"></span>');
    const test = h('<button class="btn sm">Test</button>');
    test.onclick = async () => {
      test.disabled = true; const prev = test.textContent; test.textContent = 'Testing…';
      status.className = 'muted'; status.style.fontSize = '12px'; status.textContent = '';
      try {
        const r = await api(\`/providers/\${p.name}/test\`, { method:'POST' });
        status.innerHTML = \`<span class="pill \${r.ok?'ok':'err'}">\${r.ok?'✓':'✗'}</span> \${esc(r.message)}\`;
      } catch (e) { status.innerHTML = \`<span class="pill err">✗</span> \${esc(e.message)}\`; }
      finally { test.disabled = false; test.textContent = prev; }
    };
    const tg = h(\`<button class="btn sm">\${p.enabled?'Enabled':'Disabled'}</button>\`);
    tg.classList.toggle('primary', p.enabled);
    tg.onclick = async () => { await api(\`/providers/\${p.name}\`,{method:'PATCH',body:{enabled:!p.enabled}}); viewSettings(v); };
    btns.append(test, tg); row.appendChild(btns); wrap.appendChild(row);
    wrap.appendChild(status);

    const fields = PROVIDER_CONFIG[p.name];
    if (fields) {
      const cfgForm = h('<div class="row" style="flex-direction:column;align-items:stretch;gap:8px;margin-top:8px"></div>');
      for (const [key, label, type] of fields) {
        const f = h(\`<label class="field" style="font-size:12px">\${label}</label>\`);
        const inp = h(\`<input type="\${type==='password'?'password':'text'}" value="\${esc(p.config?.[key]??'')}" placeholder="(not set)" class="input-w-full">\`);
        inp.dataset.cfg = key; f.appendChild(inp); cfgForm.appendChild(f);
      }
      const csave = h('<button class="btn sm primary" style="align-self:flex-start">Save</button>');
      csave.onclick = async () => {
        const config = {};
        for (const el of cfgForm.querySelectorAll('[data-cfg]')) if (el.value.trim()) config[el.dataset.cfg] = el.value.trim();
        await api(\`/providers/\${p.name}\`, { method:'PATCH', body:{ config } }); toast('Saved');
      };
      cfgForm.appendChild(csave); wrap.appendChild(cfgForm);
    }
    pc.appendChild(wrap);
  }
  container.appendChild(pc);`;

const providerReplace = `
  const pc = h('<div class="card" style="grid-column: 1 / -1"><h2>Sources</h2></div>');
  const tableWrap = h('<div style="overflow-x:auto"></div>');
  const table = h('<table class="w-full" style="text-align:left;font-size:14px;border-collapse:collapse;white-space:nowrap;"></table>');
  table.innerHTML = \`
    <thead>
      <tr style="border-bottom:1px solid #333">
        <th style="padding:8px">Provider</th>
        <th style="padding:8px">Type</th>
        <th style="padding:8px">Health</th>
        <th style="padding:8px">Downloaded</th>
        <th style="padding:8px">Failed</th>
        <th style="padding:8px">Quality</th>
        <th style="padding:8px">Enabled</th>
        <th style="padding:8px">Warnings</th>
      </tr>
    </thead>
    <tbody></tbody>
  \`;
  const tbody = table.querySelector('tbody');

  function starsHtml(qualityScore) {
    if (qualityScore < 0) return '<span class="muted">–</span>';
    const filled = Math.round(qualityScore * 4) + 1;
    return '<span style="color:#ffd700">' + '★'.repeat(filled) + '</span><span style="color:#555">' + '☆'.repeat(5 - filled) + '</span>';
  }

  function healthIcon(status) {
    if (status === 'red') return '🔴';
    if (status === 'orange') return '🟡';
    return '🟢';
  }

  for (const p of providers) {
    const tr = h('<tr style="border-bottom:1px solid #222"></tr>');
    const tdProv = h(\`<td style="padding:8px">\${esc(p.label)}</td>\`);
    const tdType = h(\`<td style="padding:8px"><span class="pill">\${esc(p.mediaType)}</span> <span class="pill \${p.capabilities.download||p.capabilities.archive?'acc':''}">\${capLabel(p.capabilities)}</span></td>\`);
    const tdHealth = h(\`<td style="padding:8px" title="\${p.healthStatus}">\${healthIcon(p.healthStatus)}</td>\`);
    const tdOk = h(\`<td style="padding:8px">\${(p.chaptersOk||0).toLocaleString()}</td>\`);
    const tdFail = h(\`<td style="padding:8px">\${(p.chaptersFailed||0).toLocaleString()}</td>\`);
    const tdQual = h(\`<td style="padding:8px" title="\${p.qualityScore >= 0 ? p.qualityScore.toFixed(2) : 'unrated'}">\${starsHtml(p.qualityScore ?? -1)}</td>\`);

    const tdEnab = h('<td style="padding:8px"></td>');
    const tg = h(\`<button class="btn sm" style="min-width:60px">\${p.enabled?'[on]':'[off]'}</button>\`);
    tg.classList.toggle('primary', p.enabled);
    tg.onclick = async () => { await api(\`/providers/\${p.name}\`,{method:'PATCH',body:{enabled:!p.enabled}}); viewSettings(v); };
    tdEnab.appendChild(tg);

    const tdWarn = h('<td style="padding:8px"></td>');
    if (p.warnings && p.warnings.length > 0) {
      const warnBtn = h('<button class="btn sm" title="View Warnings">[ⓘ]</button>');
      warnBtn.onclick = () => {
        const d = h('<div class="modal-overlay"><div class="modal-content" style="max-width:600px"><h2>Warnings - ' + esc(p.label) + '</h2><div style="max-height:400px;overflow-y:auto;background:#111;padding:10px;border-radius:4px;font-family:monospace;font-size:12px"></div><div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn sm">Close</button></div></div></div>');
        const list = d.querySelector('div>div');
        p.warnings.slice().reverse().forEach(w => {
           const div = document.createElement('div');
           div.style.marginBottom = '8px';
           div.innerHTML = \`<span style="color:#888">\${new Date(w.ts).toLocaleString()}</span><br/><span style="color:#f88">\${esc(w.message)}</span>\`;
           list.appendChild(div);
        });
        d.querySelector('button').onclick = () => d.remove();
        document.body.appendChild(d);
      };
      tdWarn.appendChild(warnBtn);
    }

    tr.append(tdProv, tdType, tdHealth, tdOk, tdFail, tdQual, tdEnab, tdWarn);
    tbody.appendChild(tr);

    // Config settings row (collapsible or below)
    const fields = PROVIDER_CONFIG[p.name];
    if (fields) {
      const cfgRow = h('<tr style="border-bottom:1px solid #333;background:#0d1117"><td colspan="8" style="padding:8px 12px"></td></tr>');
      const cfgTd = cfgRow.querySelector('td');
      const cfgForm = h('<div class="row" style="align-items:center;gap:8px"></div>');
      for (const [key, label, type] of fields) {
        const f = h(\`<label class="field" style="font-size:12px;display:flex;align-items:center;gap:6px">\${label}</label>\`);
        const inp = h(\`<input type="\${type==='password'?'password':'text'}" value="\${esc(p.config?.[key]??'')}" placeholder="(not set)" style="width:200px">\`);
        inp.dataset.cfg = key; f.appendChild(inp); cfgForm.appendChild(f);
      }
      const csave = h('<button class="btn sm primary">Save Config</button>');
      csave.onclick = async () => {
        const config = {};
        for (const el of cfgForm.querySelectorAll('[data-cfg]')) if (el.value.trim()) config[el.dataset.cfg] = el.value.trim();
        await api(\`/providers/\${p.name}\`, { method:'PATCH', body:{ config } }); toast('Saved');
      };
      cfgForm.appendChild(csave);

      const testBtn = h('<button class="btn sm">Test Connection</button>');
      const testStatus = h('<span class="muted" style="font-size:12px;margin-left:8px"></span>');
      testBtn.onclick = async () => {
        testBtn.disabled = true; const prev = testBtn.textContent; testBtn.textContent = 'Testing…';
        testStatus.textContent = ''; testStatus.className = 'muted';
        try {
          const r = await api(\`/providers/\${p.name}/test\`, { method:'POST' });
          testStatus.innerHTML = \`<span class="pill \${r.ok?'ok':'err'}">\${r.ok?'✓':'✗'}</span> \${esc(r.message)}\`;
        } catch (e) { testStatus.innerHTML = \`<span class="pill err">✗</span> \${esc(e.message)}\`; }
        finally { testBtn.disabled = false; testBtn.textContent = prev; }
      };
      cfgForm.append(testBtn, testStatus);
      cfgTd.appendChild(cfgForm);
      tbody.appendChild(cfgRow);
    }
  }

  tableWrap.appendChild(table);
  pc.appendChild(tableWrap);
  const legend = h('<div style="margin-top:12px;font-size:12px;color:#888">Health: 🟢 OK (<20% fail), 🟡 Warning (20-60% fail or <70% qual), 🔴 Critical (>60% fail or <40% qual)</div>');
  pc.appendChild(legend);
  container.appendChild(pc);
`;

content = content.replace(providerReplaceSearch, providerReplace);

writeFileSync('web/app.js', content);
