// Imports a raw biometric-device log dump (pulled via USB pendrive) into MongoDB.
// Expected columns (tab or multi-space separated), one header line then rows:
//   No  TMNo  EnNo  Name  GMNo  Mode  In/Out  Antipass  ProxyWork  DateTime
//
// Usage: node src/importDump.js <path-to-dump-file>

require('./timezone');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectDB } = require('./db');
const Attendance = require('./models/Attendance');
const Employee = require('./models/Employee');

// These employees are exported without names by both biometric devices.
const EMPLOYEE_NAME_OVERRIDES = new Map([
  ['00000038', 'Diya'],
  ['00000043', 'Anhadpreet'],
  ['00000044', 'Rohan'],
  ['00000045', 'Vikash'],
  ['00000046', 'Heena'],
  ['00000047', 'Affreen'],
  ['00000048', 'Angelica'],
  ['00000049', 'Robin'],
  ['00000050', 'Sukhpreet'],
  ['00000051', 'Harsh'],
  ['00000052', 'Amit'],
  ['00000053', 'Jhanvi'],
  ['00000054', 'Nikhil'],
  ['00000055', 'Aina'],
  ['00000056', 'Manvendra'],
]);

function splitRow(line) {
  // Real dumps from these devices are tab-separated; fall back to 2+ spaces if no tabs.
  const cols = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/);
  return cols.map((c) => c.trim());
}

function punchTypeFromInOut(value) {
  if (value === '1') return 'IN';
  if (value === '0') return 'OUT';
  return null; // e.g. "3" (break/other) - kept in `raw`, not forced into IN/OUT
}

function punchTypeFromMachine(tmNo, inOut) {
  if (String(tmNo) === '1515') return 'IN';
  if (String(tmNo) === '1516') return 'OUT';
  return punchTypeFromInOut(inOut);
}

function parseDump(filePath) {
  const buffer = fs.readFileSync(filePath);
  const text = buffer[0] === 0xff && buffer[1] === 0xfe
    ? buffer.toString('utf16le').replace(/^\uFEFF/, '')
    : buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const rows = [];
  const employees = new Map(); // EnNo -> Name

  for (const line of lines) {
    const cols = splitRow(line);
    if (cols.length < 10) continue; // skip header/short/garbage lines
    const [no, tmNo, enNo, name, gmNo, mode, inOut, antipass, proxyWork, dateTime] = cols;
    if (!/^\d+$/.test(no)) continue; // header row starts with "No" not a number
    if (!enNo || !dateTime) continue;

    const recordTime = new Date(dateTime.replace(' ', 'T'));
    if (Number.isNaN(recordTime.getTime())) continue;

    const employeeName = EMPLOYEE_NAME_OVERRIDES.get(enNo) || name;
    if (employeeName && !employees.has(enNo)) employees.set(enNo, employeeName);

    rows.push({
      deviceUserId: enNo,
      recordTime,
      // These two dedicated machines export "1" in the In/Out column on both
      // sides, so their machine number is the reliable direction indicator.
      punchType: punchTypeFromMachine(tmNo, inOut),
      deviceIp: `TM-${tmNo}`,
      raw: { no, tmNo, enNo, name, gmNo, mode, inOut, antipass, proxyWork, dateTime },
    });
  }

  return { rows, employees };
}

async function importDump(filePath, options = {}) {
  const parsed = parseDump(filePath);
  const through = options.until
    ? new Date(options.until)
    : options.through ? new Date(`${options.through}T23:59:59.999`) : null;
  if (through && Number.isNaN(through.getTime())) throw new Error(`Invalid import cutoff: ${options.until || options.through}`);

  const selectedIds = options.employees?.length
    ? new Set(options.employees.map((id) => String(id).padStart(8, '0')))
    : null;
  const rows = parsed.rows.filter((row) =>
    (!through || row.recordTime <= through) && (!selectedIds || selectedIds.has(row.deviceUserId))
  );
  const employeeIds = new Set(rows.map((row) => row.deviceUserId));
  const employees = new Map([...parsed.employees].filter(([enNo]) => employeeIds.has(enNo)));
  console.log(`[import] parsed ${rows.length} log row(s), ${employees.size} unique EnNo(s)`);

  if (!rows.length) {
    console.log('[import] nothing to import - check the file format/path');
    return { inserted: 0, skipped: 0, employeesUpserted: 0 };
  }

  await connectDB();

  const employeeOps = [...employees.entries()].map(([enNo, name]) => ({
    updateOne: {
      filter: { deviceUserId: enNo },
      update: { $set: { name }, $setOnInsert: { deviceUserId: enNo } },
      upsert: true,
    },
  }));
  const empResult = employeeOps.length
    ? await Employee.bulkWrite(employeeOps, { ordered: false })
    : { upsertedCount: 0, modifiedCount: 0 };

  const attendanceOps = rows.map((row) => ({
    updateOne: {
      filter: {
        deviceUserId: row.deviceUserId,
        recordTime: row.recordTime,
        punchType: row.punchType,
      },
      update: { $setOnInsert: row },
      upsert: true,
    },
  }));

  const result = await Attendance.bulkWrite(attendanceOps, { ordered: false });
  const inserted = result.upsertedCount || 0;
  const skipped = rows.length - inserted;

  console.log(`[import] employees: ${empResult.upsertedCount || 0} new, ${empResult.modifiedCount || 0} updated`);
  console.log(`[import] attendance: ${inserted} new record(s) inserted, ${skipped} duplicate(s) skipped`);

  return { inserted, skipped, employeesUpserted: employeeOps.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const filePath = args[0];
  const throughIndex = args.indexOf('--through');
  const through = throughIndex >= 0 ? args[throughIndex + 1] : null;
  const untilIndex = args.indexOf('--until');
  const until = untilIndex >= 0 ? args[untilIndex + 1] : null;
  const employeesIndex = args.indexOf('--employees');
  const employees = employeesIndex >= 0 ? args[employeesIndex + 1]?.split(',').filter(Boolean) : null;
  if (!filePath) {
    console.error('Usage: node src/importDump.js <path-to-dump-file> [--through YYYY-MM-DD | --until ISO_DATETIME] [--employees ID,ID]');
    process.exit(1);
  }
  if (throughIndex >= 0 && !through) {
    console.error('--through requires a YYYY-MM-DD value');
    process.exit(1);
  }
  if (untilIndex >= 0 && !until) {
    console.error('--until requires an ISO date-time value');
    process.exit(1);
  }
  if (employeesIndex >= 0 && !employees?.length) {
    console.error('--employees requires a comma-separated ID list');
    process.exit(1);
  }
  importDump(path.resolve(filePath), { through, until, employees })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[import] failed:', err);
      process.exit(1);
    });
}

module.exports = { importDump, parseDump, punchTypeFromMachine };
