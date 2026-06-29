import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/server/routes/api.js', 'utf8');

const mapAdd = `
      bindery.push({
        cbzPath: pkg.cbzPath,
        fileName: path.basename(pkg.cbzPath),
        seriesId: pkg.seriesId,
        seriesTitle: pkg.seriesTitle,
        seriesCover: pkg.seriesCover,
        seriesMediaType: pkg.seriesMediaType,
        volume: pkg.volume,
        packagedAt: packagedAt || new Date().toISOString(),
        size: fileSize,
        realChapters,
        scanQualities: pkg.rows.map(r => r.scan_quality).filter(q => q && q !== 'unknown'),
        dbChapters: pkg.rows.map(r => ({
          id: r.id,
          number: r.number,
          title: r.title,
          state: r.state
        }))
      });
`;

content = content.replace(/      bindery\.push\(\{\n        cbzPath: pkg\.cbzPath,\n        fileName: path\.basename\(pkg\.cbzPath\),\n        seriesId: pkg\.seriesId,\n        seriesTitle: pkg\.seriesTitle,\n        seriesCover: pkg\.seriesCover,\n        seriesMediaType: pkg\.seriesMediaType,\n        volume: pkg\.volume,\n        packagedAt: packagedAt \|\| new Date\(\)\.toISOString\(\),\n        size: fileSize,\n        realChapters,\n        dbChapters: pkg\.rows\.map\(r => \(\{\n          id: r\.id,\n          number: r\.number,\n          title: r\.title,\n          state: r\.state\n        \}\)\)\n      \}\);/, mapAdd.trim());

writeFileSync('src/server/routes/api.js', content);
