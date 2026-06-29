import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/server/routes/api.js', 'utf8');

const importAdd = `\nimport { getProviderStats } from '../../core/provider-stats.js';`;
content = content.replace(/import \{ bus \} from '\.\.\/\.\.\/core\/events\.js';/, "import { bus } from '../../core/events.js';" + importAdd);

const providerApiAdd = `
  // --- Providers ---
  app.get('/api/providers', async () => {
    const states = Object.fromEntries(getProviderStates().map(p => [p.name, p]));
    return describeProviders().map(p => {
      const stats = getProviderStats(p.name);
      return {
        ...p,
        enabled: states[p.name]?.enabled ?? false,
        config: states[p.name]?.config ?? {},
        chaptersOk: stats.chaptersOk,
        chaptersFailed: stats.chaptersFailed,
        qualityScore: stats.qualityScore,
        qualitySamples: stats.qualitySamples,
        healthStatus: stats.healthStatus,
        warnings: stats.warnings
      };
    });
  });
`;

content = content.replace(/  \/\/ --- Providers ---\n  app\.get\('\/api\/providers', async \(\) => \{\n    const states = Object\.fromEntries\(getProviderStates\(\)\.map\(p => \[p\.name, p\]\)\);\n    return describeProviders\(\)\.map\(p => \(\{ \.\.\.p, enabled: states\[p\.name\]\?\.enabled \?\? false, config: states\[p\.name\]\?\.config \?\? \{\} \}\)\);\n  \}\);/, providerApiAdd.trim());

writeFileSync('src/server/routes/api.js', content);
