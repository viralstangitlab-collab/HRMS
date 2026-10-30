require('./src/timezone');
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { connectDB } = require('./src/db');
const Attendance = require('./src/models/Attendance');
const Employee = require('./src/models/Employee');
const User = require('./src/models/User');
const AuthSession = require('./src/models/AuthSession');
const { syncStatus } = require('./src/sync');
const { startLogClientServer } = require('./src/logclient');

const port = Number(process.env.PORT || process.env.APP_PORT || 3001);
const intervalMs = Number(process.env.SYNC_INTERVAL_MS || 15000);
const departments = ['Viralstan', 'Vitoxyz', 'Transvera', 'RevnoRCM', 'Elitesbook'];
const employeeRoles = ['Employee', 'Manager', 'Board Member'];
const employeeFields = ['name', 'firstName', 'middleName', 'lastName', 'phone', 'alternatePhone', 'department', 'role', 'employeeCode', 'joiningDate', 'dateOfBirth', 'gender', 'employmentType', 'alias', 'workEmail', 'personalEmail', 'pan', 'maritalStatus', 'bloodGroup', 'fatherName', 'motherName', 'bankAccount', 'ifsc', 'accountType', 'bankName', 'bankBranch', 'accountHolder', 'aadhaar', 'aadhaarName', 'emergencyContactName', 'emergencyPhone', 'nationality', 'designation', 'location', 'team', 'shift', 'monthlySalary', 'salaryEffectiveFrom', 'salaryNotes', 'active', 'leftCompany', 'leftOn'];
const loginEmail = String(process.env.LOGIN_EMAIL || '').trim().toLowerCase();
const loginPassword = String(process.env.LOGIN_PASSWORD || '');
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const loginAttempts = new Map();

function passwordDigest(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function passwordMatches(password, salt, expectedHash) {
  const actual = Buffer.from(passwordDigest(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function ensureLoginUser() {
  if (!loginEmail || !loginPassword) {
    const existingAdmin = await User.findOne({ role: 'admin', active: true }).lean();
    if (!existingAdmin) throw new Error('No active administrator exists in MongoDB. Set LOGIN_EMAIL and LOGIN_PASSWORD once to create it.');
    console.log(`[auth] using MongoDB administrator: ${existingAdmin.email}`);
    return existingAdmin;
  }
  let user = await User.findOne({ email: loginEmail }).select('+passwordHash +passwordSalt');
  if (user && passwordMatches(loginPassword, user.passwordSalt, user.passwordHash)) return user;
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const passwordHash = passwordDigest(loginPassword, passwordSalt);
  user = await User.findOneAndUpdate(
    { email: loginEmail },
    { email: loginEmail, passwordSalt, passwordHash, active: true, role: 'admin' },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`[auth] administrator account saved in MongoDB: ${loginEmail}`);
  return user;
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === name) return decodeURIComponent(cookie.slice(separator + 1).trim());
  }
  return '';
}

async function authenticated(req) {
  const token = cookieValue(req, 'attendance_session');
  if (!token) return false;
  const session = await AuthSession.findOne({ tokenHash: tokenDigest(token), expiresAt: { $gt: new Date() } }).lean();
  if (!session) return false;
  return true;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto']).toLowerCase() === 'https';
  return `attendance_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function employeeUpdate(body) {
  const update = {};
  for (const field of employeeFields) if (body[field] !== undefined) update[field] = body[field];
  if (update.name !== undefined) update.name = String(update.name).trim();
  if (update.department && !departments.includes(update.department)) throw new Error('Invalid department');
  if (update.role && !employeeRoles.includes(update.role)) throw new Error('Invalid employee role');
  return update;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

async function employeeNameMap() {
  const employees = await Employee.find().lean();
  const map = new Map();
  for (const employee of employees) map.set(employee.deviceUserId, employee.name);
  return map;
}

function withNames(records, nameMap) {
  return records.map((record) => {
    const deviceUserId = normalizeEnrollmentId(record.deviceUserId);
    return { ...record, deviceUserId, employeeName: nameMap.get(deviceUserId) || null };
  });
}

// Enrollment IDs (padded and unpadded) of employees marked "Left Company".
async function leftEmployeeIds() {
  const rows = await Employee.find({ leftCompany: true }, { deviceUserId: 1 }).lean();
  return rows.flatMap((row) => {
    const id = normalizeEnrollmentId(row.deviceUserId);
    return /^\d+$/.test(id) ? [id, String(Number(id))] : [id];
  });
}

// Adds "not a left employee" to an Attendance filter.
function withoutLeft(query, leftIds) {
  return leftIds.length ? { $and: [query, { deviceUserId: { $nin: leftIds } }] } : query;
}

const currentEmployeesFilter = { leftCompany: { $ne: true } };

function completeEmployeeList(employees, attendanceIds) {
  const byId = new Map(employees.map((employee) => [employee.deviceUserId, employee]));
  for (const rawId of attendanceIds) {
    const deviceUserId = normalizeEnrollmentId(rawId);
    if (!byId.has(deviceUserId)) {
      byId.set(deviceUserId, {
        _id: null,
        deviceUserId,
        name: `Unnamed #${Number(deviceUserId)}`,
        active: true,
        placeholder: true,
      });
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.deviceUserId.localeCompare(b.deviceUserId, undefined, { numeric: true })
  );
}

function normalizeEnrollmentId(value) {
  const text = String(value || '').trim();
  return /^\d{1,8}$/.test(text) ? text.padStart(8, '0') : text;
}

async function resolveEnrollmentId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{1,8}$/.test(text)) return normalizeEnrollmentId(text);
  const needle = text.toLocaleLowerCase('en-IN');
  const employees = await Employee.find({}, { deviceUserId: 1, name: 1 }).lean();
  const exact = employees.find((employee) => employee.name?.trim().toLocaleLowerCase('en-IN') === needle);
  if (exact) return exact.deviceUserId;
  const partial = employees.filter((employee) => employee.name?.trim().toLocaleLowerCase('en-IN').includes(needle));
  return partial.length === 1 ? partial[0].deviceUserId : '__NOT_FOUND__';
}

function buildDailyReport(records, dayEnd) {
  const byUser = new Map();
  for (const record of records) {
    if (!byUser.has(record.deviceUserId)) byUser.set(record.deviceUserId, []);
    byUser.get(record.deviceUserId).push(record);
  }
  return [...byUser.entries()].map(([deviceUserId, punches]) => {
    punches.sort((a, b) => new Date(a.recordTime) - new Date(b.recordTime));
    // The working window runs from the day's first IN (1515) to the last OUT
    // (1516) after it. Time spent outside between an OUT and the next IN is a
    // break and is deducted, so insideMs is the real time spent inside.
    // Repeated scans on the same machine collapse: the first IN of an IN run
    // and the last OUT of an OUT run are the actual entry and exit.
    const firstInPunch = punches.find((p) => p.punchType === 'IN') || null;
    const lastOutPunch = firstInPunch
      ? [...punches].reverse().find((p) => p.punchType === 'OUT' && new Date(p.recordTime) > new Date(firstInPunch.recordTime)) || null
      : null;
    const sessions = [];
    const breaks = [];
    if (lastOutPunch) {
      const windowStart = new Date(firstInPunch.recordTime);
      const windowEnd = new Date(lastOutPunch.recordTime);
      const runs = [];
      for (const punch of punches) {
        const t = new Date(punch.recordTime);
        if (!['IN', 'OUT'].includes(punch.punchType) || t < windowStart || t > windowEnd) continue;
        const lastRun = runs[runs.length - 1];
        if (!lastRun || lastRun.type !== punch.punchType) runs.push({ type: punch.punchType, punches: [punch] });
        else lastRun.punches.push(punch);
      }
      // runs alternate IN, OUT, IN, OUT ... and always start with IN and end with OUT
      for (let index = 0; index + 1 < runs.length; index += 2) {
        const entry = runs[index].punches[0].recordTime;
        const exit = runs[index + 1].punches[runs[index + 1].punches.length - 1].recordTime;
        sessions.push({ in: entry, out: exit, durationMs: new Date(exit) - new Date(entry) });
        const nextIn = runs[index + 2]?.punches[0].recordTime;
        if (nextIn) breaks.push({ out: exit, in: nextIn, durationMs: new Date(nextIn) - new Date(exit) });
      }
    }
    const spanMs = lastOutPunch ? new Date(lastOutPunch.recordTime) - new Date(firstInPunch.recordTime) : 0;
    const breakMs = breaks.reduce((sum, item) => sum + item.durationMs, 0);
    const insideMs = spanMs - breakMs;
    const lastPunch = punches[punches.length - 1];
    return {
      deviceUserId,
      employeeName: punches[0].employeeName || null,
      firstIn: firstInPunch?.recordTime || null,
      lastOut: lastOutPunch?.recordTime || null,
      insideMs,
      spanMs,
      breakMs,
      breaks,
      isComplete: Boolean(lastOutPunch),
      // Incomplete only when the day has no IN, or no OUT after the first IN.
      hasIncompletePunch: !lastOutPunch,
      currentStatus: lastPunch.punchType === 'IN' ? 'INSIDE' : 'OUTSIDE',
      punchCount: punches.length,
      sessions,
      punches,
    };
  }).sort((a, b) => a.deviceUserId.localeCompare(b.deviceUserId, undefined, { numeric: true }));
}

const QUALITY_GREEN_MIN = 480;
const QUALITY_ORANGE_MIN = 465;

function classifyQuality(totalMinutes, punchCount) {
  if (punchCount === 0) return 'absent';
  if (totalMinutes >= QUALITY_GREEN_MIN) return 'green';
  if (totalMinutes >= QUALITY_ORANGE_MIN) return 'orange';
  return 'red';
}

function monthRangeLocal(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const days = new Date(year, month, 0).getDate();
  return { start, end, days, year, month };
}

function localDateKey(value) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The attendance workday changes at 6 AM rather than midnight. This keeps every
// punch from an evening/night shift (including after-midnight break re-entries)
// on the date on which that shift started.
function attendanceDateGroups(records) {
  const byUser = new Map();
  for (const record of records) {
    if (!byUser.has(record.deviceUserId)) byUser.set(record.deviceUserId, []);
    byUser.get(record.deviceUserId).push(record);
  }
  const groups = new Map();
  for (const punches of byUser.values()) {
    punches.sort((a, b) => new Date(a.recordTime) - new Date(b.recordTime));
    for (const punch of punches) {
      const punchTime = new Date(punch.recordTime);
      const workday = new Date(punchTime);
      if (workday.getHours() < 6) workday.setDate(workday.getDate() - 1);
      const date = localDateKey(workday);
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push(punch);
    }
  }
  return groups;
}

function buildRangeSummary(records, fromText, toText, selectedEmployee, employeeDirectory = []) {
  const groups = attendanceDateGroups(records);
  const now = new Date();
  const result = [...groups.entries()].filter(([date]) => date >= fromText && date <= toText).flatMap(([date, dayRecords]) => {
    const [year, month, day] = date.split('-').map(Number);
    const end = new Date(year, month - 1, day + 1);
    const start = new Date(year, month - 1, day);
    const effectiveEnd = now >= start && now < end ? now : end;
    return buildDailyReport(dayRecords, effectiveEnd).map((entry) => ({
      date,
      ...entry,
      // Compact punch list for the day-detail popup on the dashboard.
      timeline: entry.punches.map((p) => ({ time: p.recordTime, type: p.punchType, device: p.deviceIp, mode: p.raw?.mode ?? null })),
      punches: undefined,
    }));
  });
  const employeesToFill = selectedEmployee ? [selectedEmployee] : employeeDirectory;
  for (const employee of employeesToFill) {
    const [fy, fm, fd] = fromText.split('-').map(Number);
    const [ty, tm, td] = toText.split('-').map(Number);
    for (let cursor = new Date(fy, fm - 1, fd), end = new Date(ty, tm - 1, td); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const date = localDateKey(cursor);
      const hasEmployeeEntry = result.some((entry) => entry.date === date && entry.deviceUserId === employee.deviceUserId);
      if (!hasEmployeeEntry && selectedEmployee) {
        result.push({ date, deviceUserId: employee.deviceUserId, employeeName: employee.name, absent: true, firstIn: null, lastOut: null, insideMs: 0, punchCount: 0, sessions: [] });
      }
    }
  }
  return result.sort((a, b) => b.date.localeCompare(a.date) || a.deviceUserId.localeCompare(b.deviceUserId, undefined, { numeric: true }));
}

const server = http.createServer(async (req, res) => {
  const safePath = String(req.url || '/').replace(/^\/{2,}/, '/');
  const url = new URL(safePath, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/login') {
      if (await authenticated(req)) return redirect(res, '/overview');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8'));
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const clientKey = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
      const attempt = loginAttempts.get(clientKey);
      if (attempt?.blockedUntil > Date.now()) return json(res, 429, { error: 'Too many attempts. Please try again later.' });
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const user = await User.findOne({ email, active: true }).select('+passwordHash +passwordSalt');
      const valid = Boolean(user && passwordMatches(body.password || '', user.passwordSalt, user.passwordHash));
      if (!valid) {
        const failures = (attempt?.failures || 0) + 1;
        loginAttempts.set(clientKey, { failures: failures >= 5 ? 0 : failures, blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
        return json(res, 401, { error: 'Invalid email or password' });
      }
      loginAttempts.delete(clientKey);
      const token = crypto.randomBytes(32).toString('hex');
      await AuthSession.create({ userId: user._id, tokenHash: tokenDigest(token), expiresAt: new Date(Date.now() + sessionTtlMs) });
      await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
      res.setHeader('set-cookie', sessionCookie(req, token, Math.floor(sessionTtlMs / 1000)));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = cookieValue(req, 'attendance_session');
      if (token) await AuthSession.deleteOne({ tokenHash: tokenDigest(token) });
      res.setHeader('set-cookie', sessionCookie(req, '', 0));
      return json(res, 200, { ok: true });
    }
    if (!await authenticated(req)) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Authentication required' });
      return redirect(res, '/login');
    }
    if (req.method === 'GET' && ['/', '/overview', '/attendance', '/punches', '/employees', '/profiles', '/salary', '/monthly-attendance'].includes(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate' });
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
    }
    if (req.method === 'GET' && (url.pathname === '/live' || url.pathname === '/live/' || url.pathname.startsWith('/live/'))) {
      const staticMap = { '/live': 'index.html', '/live/': 'index.html', '/live/index.html': 'index.html', '/live/style.css': 'style.css', '/live/app.js': 'app.js' };
      const fileName = staticMap[url.pathname];
      if (!fileName) return json(res, 404, { error: 'Not found' });
      const contentType = fileName.endsWith('.css') ? 'text/css; charset=utf-8' : fileName.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': contentType });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'live', fileName), 'utf8'));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, syncStatus);
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const leftIds = await leftEmployeeIds();
      const visible = withoutLeft({}, leftIds);
      const [totalRecords, inRecords, outRecords, range, attendanceIds, employees, faceRecords, fingerprintRecords, recent, dailyTrend] = await Promise.all([
        Attendance.countDocuments(visible),
        Attendance.countDocuments(withoutLeft({ punchType: 'IN' }, leftIds)),
        Attendance.countDocuments(withoutLeft({ punchType: 'OUT' }, leftIds)),
        Attendance.aggregate([{ $match: visible }, { $group: { _id: null, first: { $min: '$recordTime' }, last: { $max: '$recordTime' } } }]),
        Attendance.distinct('deviceUserId', visible),
        Employee.find(currentEmployeesFilter, { deviceUserId: 1, name: 1 }).lean(),
        Attendance.countDocuments(withoutLeft({ $or: [{ 'raw.mode': { $in: ['15', '30'] } }, { 'raw.verificationMode': { $in: ['15', '30'] } }] }, leftIds)),
        Attendance.countDocuments(withoutLeft({ $or: [{ 'raw.mode': '1' }, { 'raw.verificationMode': '1' }] }, leftIds)),
        Attendance.find(visible).sort({ recordTime: -1 }).limit(12).lean(),
        Attendance.aggregate([
          { $match: visible },
          { $group: {
            _id: { $dateToString: { date: '$recordTime', format: '%Y-%m-%d', timezone: '+05:30' } },
            punches: { $sum: 1 },
            employees: { $addToSet: '$deviceUserId' },
            ins: { $sum: { $cond: [{ $eq: ['$punchType', 'IN'] }, 1, 0] } },
            outs: { $sum: { $cond: [{ $eq: ['$punchType', 'OUT'] }, 1, 0] } },
          } },
          { $sort: { _id: -1 } },
          { $limit: 14 },
          { $project: { _id: 0, date: '$_id', punches: 1, employees: { $size: '$employees' }, ins: 1, outs: 1 } },
          { $sort: { date: 1 } },
        ]),
      ]);
      const names = new Map(employees.map((employee) => [employee.deviceUserId, employee.name]));
      const namedEmployees = attendanceIds.filter((id) => names.get(id)?.trim()).length;
      return json(res, 200, {
        totals: {
          records: totalRecords,
          inRecords,
          outRecords,
          employees: attendanceIds.length,
          namedEmployees,
          unnamedEmployees: attendanceIds.length - namedEmployees,
          faceRecords,
          fingerprintRecords,
        },
        range: { first: range[0]?.first || null, last: range[0]?.last || null },
        recent: withNames(recent, names),
        dailyTrend,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/attendance') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000);
      const leftIds = await leftEmployeeIds();
      const [records, nameMap] = await Promise.all([
        Attendance.find(withoutLeft({}, leftIds)).sort({ recordTime: -1 }).limit(limit).lean(),
        employeeNameMap(),
      ]);
      return json(res, 200, { records: withNames(records, nameMap) });
    }
    if (req.method === 'GET' && url.pathname === '/api/employees') {
      const leftIds = await leftEmployeeIds();
      const [employees, attendanceIds, leftEmployees] = await Promise.all([
        Employee.find(currentEmployeesFilter).sort({ deviceUserId: 1 }).lean(),
        Attendance.distinct('deviceUserId', withoutLeft({}, leftIds)),
        Employee.find({ leftCompany: true }).sort({ deviceUserId: 1 }).lean(),
      ]);
      const namedIds = new Set(employees.filter((employee) => employee.name?.trim()).map((employee) => normalizeEnrollmentId(employee.deviceUserId)));
      const unnamedIds = [...new Set(attendanceIds.map(normalizeEnrollmentId))]
        .filter((id) => !namedIds.has(id))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return json(res, 200, { employees: completeEmployeeList(employees, attendanceIds), leftEmployees, unnamedIds, departments, employeeRoles });
    }
    if (req.method === 'GET' && url.pathname === '/api/monthly-summary') {
      const monthStr = url.searchParams.get('month') || localDateKey(new Date()).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(monthStr)) return json(res, 400, { error: 'Invalid month' });
      const { start, end, days, year, month } = monthRangeLocal(monthStr);
      const leftIds = await leftEmployeeIds();
      const [records, storedEmployees, attendanceIds] = await Promise.all([
        Attendance.find(withoutLeft({ recordTime: { $gte: new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1), $lt: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) } }, leftIds)).sort({ recordTime: 1 }).lean(),
        Employee.find(currentEmployeesFilter).sort({ deviceUserId: 1 }).lean(),
        Attendance.distinct('deviceUserId', withoutLeft({}, leftIds)),
      ]);
      const employees = completeEmployeeList(storedEmployees, attendanceIds);
      const nameMap = new Map(employees.map((employee) => [employee.deviceUserId, employee.name]));
      const named = withNames(records, nameMap);
      const byDate = attendanceDateGroups(named);
      const now = new Date();
      const todayKey = localDateKey(now);
      const perEmployee = new Map();
      for (const employee of employees) {
        perEmployee.set(employee.deviceUserId, {
          deviceUserId: employee.deviceUserId, name: employee.name, department: employee.department || null,
          designation: employee.designation || null, totalMinutes: 0, presentDays: 0, workedDays: 0,
          greenDays: 0, orangeDays: 0, redDays: 0, absentDays: 0,
        });
      }
      for (let day = 1; day <= days; day += 1) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (key > todayKey) continue;
        const dayEnd = key === todayKey ? now : new Date(year, month - 1, day + 1);
        const report = buildDailyReport(byDate.get(key) || [], dayEnd);
        const seen = new Set();
        for (const entry of report) {
          const stat = perEmployee.get(entry.deviceUserId);
          if (!stat) continue;
          seen.add(entry.deviceUserId);
          const minutes = Math.round(entry.insideMs / 60000);
          stat.totalMinutes += minutes;
          if (entry.punchCount > 0) { stat.presentDays += 1; stat.workedDays += 1; }
          const quality = classifyQuality(minutes, entry.punchCount);
          if (quality === 'green') stat.greenDays += 1;
          else if (quality === 'orange') stat.orangeDays += 1;
          else if (quality === 'red') stat.redDays += 1;
          else stat.absentDays += 1;
        }
        for (const [deviceUserId, stat] of perEmployee) {
          if (!seen.has(deviceUserId)) stat.absentDays += 1;
        }
      }
      const result = [...perEmployee.values()].map((stat) => ({
        ...stat,
        avgMinutes: stat.workedDays ? Math.round(stat.totalMinutes / stat.workedDays) : 0,
        overallQuality: classifyQuality(stat.workedDays ? Math.round(stat.totalMinutes / stat.workedDays) : 0, stat.workedDays),
      }));
      return json(res, 200, { month: monthStr, employees: result });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/monthly-summary/')) {
      const deviceUserId = decodeURIComponent(url.pathname.slice('/api/monthly-summary/'.length));
      const monthStr = url.searchParams.get('month') || localDateKey(new Date()).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(monthStr)) return json(res, 400, { error: 'Invalid month' });
      const { start, end, days, year, month } = monthRangeLocal(monthStr);
      const alternateId = /^0+\d+$/.test(deviceUserId) ? String(Number(deviceUserId)) : deviceUserId;
      const [storedEmployee, records] = await Promise.all([
        Employee.findOne({ deviceUserId }).lean(),
        Attendance.find({ deviceUserId: { $in: [...new Set([deviceUserId, alternateId])] }, recordTime: { $gte: new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1), $lt: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) } }).sort({ recordTime: 1 }).lean(),
      ]);
      const employee = storedEmployee || (records.length ? {
        deviceUserId, name: `Unnamed #${Number(deviceUserId)}`, placeholder: true,
      } : null);
      if (!employee) return json(res, 404, { error: 'Employee not found' });
      if (employee.leftCompany) return json(res, 404, { error: 'Employee has left the company' });
      const byDate = attendanceDateGroups(withNames(records, new Map([[deviceUserId, employee.name]])));
      const now = new Date();
      const todayKey = localDateKey(now);
      const dayList = [];
      const summary = { totalMinutes: 0, presentDays: 0, workedDays: 0, greenDays: 0, orangeDays: 0, redDays: 0, absentDays: 0 };
      for (let day = 1; day <= days; day += 1) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (key > todayKey) { dayList.push({ date: key, status: 'future', firstIn: null, lastOut: null, minutes: 0, sessions: [] }); continue; }
        const dayEnd = key === todayKey ? now : new Date(year, month - 1, day + 1);
        const [entry] = buildDailyReport(byDate.get(key) || [], dayEnd);
        const minutes = entry ? Math.round(entry.insideMs / 60000) : 0;
        const punchCount = entry ? entry.punchCount : 0;
        const status = classifyQuality(minutes, punchCount);
        summary.totalMinutes += minutes;
        if (punchCount > 0) { summary.presentDays += 1; summary.workedDays += 1; }
        if (status === 'green') summary.greenDays += 1;
        else if (status === 'orange') summary.orangeDays += 1;
        else if (status === 'red') summary.redDays += 1;
        else summary.absentDays += 1;
        dayList.push({
          date: key, status, minutes, punchCount,
          firstIn: entry?.firstIn || null, lastOut: entry?.lastOut || null,
          sessions: entry?.sessions || [], hasIncompletePunch: entry?.hasIncompletePunch || false,
        });
      }
      summary.avgMinutes = summary.workedDays ? Math.round(summary.totalMinutes / summary.workedDays) : 0;
      return json(res, 200, { employee: { deviceUserId: employee.deviceUserId, name: employee.name, department: employee.department || null, designation: employee.designation || null }, month: monthStr, days: dayList, summary });
    }
    if (req.method === 'POST' && url.pathname === '/api/employees') {
      const body = await readBody(req);
      if (!body.deviceUserId || !body.name) return json(res, 400, { error: 'deviceUserId and name are required' });
      const deviceUserId = normalizeEnrollmentId(body.deviceUserId);
      const fields = employeeUpdate(body);
      const employee = await Employee.findOneAndUpdate(
        { deviceUserId },
        { deviceUserId, ...fields },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return json(res, 200, { employee });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/api/employees/')) {
      const id = url.pathname.slice('/api/employees/'.length);
      const body = await readBody(req);
      const employee = await Employee.findByIdAndUpdate(id, employeeUpdate(body), { new: true, runValidators: true });
      if (!employee) return json(res, 404, { error: 'Employee not found' });
      return json(res, 200, { employee });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/employees/')) {
      const id = url.pathname.slice('/api/employees/'.length);
      const result = await Employee.findByIdAndDelete(id);
      if (!result) return json(res, 404, { error: 'Employee not found' });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/report') {
      const requested = url.searchParams.get('date') || localDateKey(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) return json(res, 400, { error: 'Invalid date' });
      const [year, month, day] = requested.split('-').map(Number);
      const start = new Date(year, month - 1, day);
      const end = new Date(year, month - 1, day + 1);
      const contextStart = new Date(year, month - 1, day - 1);
      const contextEnd = new Date(year, month - 1, day + 2);
      const now = new Date();
      const effectiveEnd = now >= start && now < end ? now : end;
      const employee = url.searchParams.get('employee');
      const employeeId = await resolveEnrollmentId(employee);
      const reportQuery = { recordTime: { $gte: contextStart, $lt: contextEnd } };
      if (employeeId) reportQuery.deviceUserId = employeeId;
      const leftIds = await leftEmployeeIds();
      const [records, storedEmployees, allAttendanceIds] = await Promise.all([
        Attendance.find(withoutLeft(reportQuery, leftIds)).sort({ recordTime: 1 }).lean(),
        Employee.find(currentEmployeesFilter).sort({ deviceUserId: 1 }).lean(),
        Attendance.distinct('deviceUserId', withoutLeft({}, leftIds)),
      ]);
      const directory = completeEmployeeList(storedEmployees, allAttendanceIds);
      const nameMap = new Map(directory.map((entry) => [entry.deviceUserId, entry.name]));
      const requestedRecords = attendanceDateGroups(withNames(records, nameMap)).get(requested) || [];
      const activity = buildDailyReport(requestedRecords, effectiveEnd);
      const activityById = new Map(activity.map((entry) => [entry.deviceUserId, entry]));
      const employees = (employeeId
        ? directory.filter((entry) => entry.deviceUserId === employeeId)
        : directory
      ).map((entry) => activityById.get(entry.deviceUserId) || {
        deviceUserId: entry.deviceUserId,
        employeeName: entry.name,
        firstIn: null,
        lastOut: null,
        insideMs: 0,
        isComplete: false,
        hasIncompletePunch: false,
        currentStatus: 'ABSENT',
        punchCount: 0,
        sessions: [],
        punches: [],
        absent: true,
      });
      return json(res, 200, {
        date: requested,
        employees,
        totals: {
          employees: employees.length,
          insideNow: employees.filter((employee) => employee.currentStatus === 'INSIDE').length,
          outsideNow: employees.filter((employee) => employee.currentStatus === 'OUTSIDE').length,
          punches: requestedRecords.length,
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      const fromText = url.searchParams.get('from');
      const toText = url.searchParams.get('to');
      const employee = url.searchParams.get('employee');
      if (!fromText || !toText || !/^\d{4}-\d{2}-\d{2}$/.test(fromText) || !/^\d{4}-\d{2}-\d{2}$/.test(toText)) {
        return json(res, 400, { error: 'Valid from and to dates are required' });
      }
      const localDate = (text, nextDay = false) => {
        const [year, month, day] = text.split('-').map(Number);
        return new Date(year, month - 1, day + (nextDay ? 1 : 0));
      };
      const employeeId = await resolveEnrollmentId(employee);
      const rawStart = localDate(fromText);
      const rawEnd = localDate(toText, true);
      const query = { recordTime: { $gte: new Date(rawStart.getFullYear(), rawStart.getMonth(), rawStart.getDate() - 1), $lt: new Date(rawEnd.getFullYear(), rawEnd.getMonth(), rawEnd.getDate() + 1) } };
      if (employeeId) query.deviceUserId = employeeId;
      const leftIds = await leftEmployeeIds();
      const [records, storedEmployees, attendanceIds] = await Promise.all([
        Attendance.find(withoutLeft(query, leftIds)).sort({ recordTime: -1 }).limit(100000).lean(),
        Employee.find(currentEmployeesFilter).sort({ deviceUserId: 1 }).lean(),
        Attendance.distinct('deviceUserId', withoutLeft({}, leftIds)),
      ]);
      const employeeDirectory = completeEmployeeList(storedEmployees, attendanceIds);
      const nameMap = new Map(employeeDirectory.map((entry) => [entry.deviceUserId, entry.name]));
      const contextRecords = withNames(records, nameMap);
      const namedRecords = contextRecords.filter((record) => new Date(record.recordTime) >= rawStart && new Date(record.recordTime) < rawEnd);
      const selectedEmployee = employeeId && employeeId !== '__NOT_FOUND__' && !leftIds.includes(employeeId)
        ? { deviceUserId: employeeId, name: nameMap.get(employeeId) || null }
        : null;
      return json(res, 200, {
        from: fromText,
        to: toText,
        count: namedRecords.length,
        summaries: buildRangeSummary(contextRecords, fromText, toText, selectedEmployee, employeeDirectory),
        records: namedRecords,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/sync') {
      return json(res, 200, { message: 'Biometric sync is disabled; use manual attendance entry' });
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 500, { error: error.message }); }
});

async function main() {
  // Bind Render's port first so the platform can detect the web service.
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        error.message = `Port ${port} is already in use. Stop the other server or set APP_PORT to a different port in .env.`;
      }
      reject(error);
    };

    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      console.log(`[app] http://localhost:${port}`);
      resolve();
    });
  });
  // Then initialize MongoDB/authentication. The dashboard remains reachable
  // while this startup work completes.
  await connectDB();
  await ensureLoginUser();
  // Render and other cloud hosts cannot reach the office LAN. Keep the web
  // service available even when the optional local device bridge is disabled.
  console.log('[device] biometric sync disabled; manual attendance mode');
}
main().catch((error) => { console.error('[fatal]', error.message); process.exit(1); });
