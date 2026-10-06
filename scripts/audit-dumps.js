const fs = require('fs');
const path = require('path');
const { parseDump } = require('../src/importDump');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/audit-dumps.js <IN dump> <OUT dump>');
  process.exit(1);
}

const parsedFiles = files.map((file) => parseDump(path.resolve(file)));
const records = parsedFiles.flatMap((parsed) => parsed.rows);
records.sort((a, b) => a.recordTime - b.recordTime);

const csvCell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const localKey = (date) => {
  const d = new Date(date);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const timeText = (date) => date ? new Date(date).toLocaleString('sv-SE').replace(' ', 'T') : '';

const names = new Map(parsedFiles.flatMap((parsed) => [...parsed.employees]));
for (const row of records) {
  const rawName = String(row.raw.name || '').trim();
  if (rawName && !names.has(row.deviceUserId)) names.set(row.deviceUserId, rawName);
}

const groups = new Map();
for (const row of records) {
  const key = `${localKey(row.recordTime)}|${row.deviceUserId}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const detail = [];
for (const [key, punches] of groups) {
  const [date, employeeId] = key.split('|');
  punches.sort((a, b) => a.recordTime - b.recordTime);
  const ins = punches.filter((p) => p.punchType === 'IN');
  const outs = punches.filter((p) => p.punchType === 'OUT');
  const firstIn = ins[0]?.recordTime || null;
  const lastOut = outs[outs.length - 1]?.recordTime || null;
  const validSpan = firstIn && lastOut && lastOut > firstIn;
  const runs = [];
  for (const punch of punches) {
    const lastRun = runs[runs.length - 1];
    if (!lastRun || lastRun.type !== punch.punchType) runs.push({ type: punch.punchType, punches: [punch] });
    else lastRun.punches.push(punch);
  }
  let workedMs = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const inRun = runs[index];
    const outRun = runs[index + 1];
    if (inRun.type !== 'IN' || outRun?.type !== 'OUT') continue;
    workedMs += Math.max(0, outRun.punches[outRun.punches.length - 1].recordTime - inRun.punches[0].recordTime);
  }
  detail.push({
    date,
    employeeId,
    name: names.get(employeeId) || '',
    firstIn: timeText(firstIn),
    lastOut: timeText(lastOut),
    spanMinutes: validSpan ? Math.round((lastOut - firstIn) / 60000) : '',
    workedMinutes: Math.round(workedMs / 60000),
    inPunches: ins.length,
    outPunches: outs.length,
    totalPunches: punches.length,
    status: !ins.length ? 'MISSING_IN' : !outs.length ? 'MISSING_OUT' : !validSpan ? 'OUT_BEFORE_IN' : 'OK',
  });
}
detail.sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId, undefined, { numeric: true }));

const daily = new Map();
for (const row of detail) {
  if (!daily.has(row.date)) daily.set(row.date, { date: row.date, employees: 0, ok: 0, missingIn: 0, missingOut: 0, outBeforeIn: 0, punches: 0 });
  const day = daily.get(row.date);
  day.employees += 1;
  day.punches += row.totalPunches;
  if (row.status === 'OK') day.ok += 1;
  if (row.status === 'MISSING_IN') day.missingIn += 1;
  if (row.status === 'MISSING_OUT') day.missingOut += 1;
  if (row.status === 'OUT_BEFORE_IN') day.outBeforeIn += 1;
}

fs.mkdirSync(path.resolve('reports'), { recursive: true });
const detailColumns = ['date', 'employeeId', 'name', 'firstIn', 'lastOut', 'spanMinutes', 'workedMinutes', 'inPunches', 'outPunches', 'totalPunches', 'status'];
const dailyColumns = ['date', 'employees', 'ok', 'missingIn', 'missingOut', 'outBeforeIn', 'punches'];
fs.writeFileSync(path.resolve('reports', 'attendance-date-wise.csv'), [detailColumns.join(','), ...detail.map((r) => detailColumns.map((c) => csvCell(r[c])).join(','))].join('\n'));
fs.writeFileSync(path.resolve('reports', 'attendance-daily-summary.csv'), [dailyColumns.join(','), ...[...daily.values()].map((r) => dailyColumns.map((c) => csvCell(r[c])).join(','))].join('\n'));

const blankIds = [...new Set(records.filter((r) => !String(r.raw.name || '').trim()).map((r) => r.deviceUserId))].sort();
const statusCounts = detail.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] || 0) + 1 }), {});
console.log(JSON.stringify({
  sourceRows: records.length,
  firstPunch: records[0]?.recordTime,
  lastPunch: records[records.length - 1]?.recordTime,
  uniqueEmployees: new Set(records.map((r) => r.deviceUserId)).size,
  dates: daily.size,
  employeeDays: detail.length,
  statusCounts,
  blankNameIds: blankIds,
  outputs: ['reports/attendance-date-wise.csv', 'reports/attendance-daily-summary.csv'],
}, null, 2));
