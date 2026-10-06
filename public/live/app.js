// ---------- helpers ----------
function todayStr() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now - offset * 60000).toISOString().slice(0, 10);
}
function currentMonthStr() { return todayStr().slice(0, 7); }

function fmtTime(iso) {
  if (!iso) return '&ndash;';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtShortTime(iso) {
  if (!iso) return '&ndash;';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function fmtHours(minutes) {
  if (!minutes && minutes !== 0) return '&ndash;';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function statusPill(status, customLabel) {
  const label = customLabel || status.charAt(0).toUpperCase() + status.slice(1);
  return `<span class="status-pill ${status}">${label}</span>`;
}

function classifyToday(totalMinutes, punchCount) {
  if (punchCount === 0) return 'absent';
  if (totalMinutes >= 480) return 'green';
  if (totalMinutes >= 465) return 'orange';
  return 'red';
}

function verifyModeLabel(record) {
  const raw = record.raw || {};
  const code = String(raw.verificationMode ?? raw.mode ?? '').trim();
  const labels = { '1': 'Fingerprint', '3': 'Password / PIN', '15': 'Face', '30': 'Face' };
  return code ? (labels[code] || 'Device') + ' &middot; ' + code : '&ndash;';
}

function initials(name, id) {
  const text = (name || String(id || '?')).trim();
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

function empCell(name, id) {
  return `<div class="emp-cell"><div class="avatar">${initials(name, id)}</div><div><div class="emp-name">${name || '#' + id}</div><div class="emp-id">#${id}</div></div></div>`;
}

function emptyRow(colspan, text) {
  return `<tr class="empty-row"><td colspan="${colspan}">${text}</td></tr>`;
}

function greetingWord() {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}
document.getElementById('greeting').textContent = greetingWord() + ',';

// ---------- tabs ----------
const tabs = document.querySelectorAll('.pill[data-tab]');
const views = document.querySelectorAll('.view');

function showView(id) {
  views.forEach((v) => v.classList.toggle('hidden', v.id !== id));
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
}

tabs.forEach((t) => {
  t.addEventListener('click', () => {
    showView(t.dataset.tab);
    if (t.dataset.tab === 'employeesView') loadEmployeesSummary();
  });
});

// ---------- Dashboard (Live) view ----------
const datePicker = document.getElementById('datePicker');
const refreshBtn = document.getElementById('refreshBtn');
const lastUpdated = document.getElementById('lastUpdated');

datePicker.value = todayStr();

async function loadDashboardTab(date) {
  const [reportRes, employeesRes, punchesRes] = await Promise.all([
    fetch(`/api/report?date=${date}`).then((r) => r.json()),
    fetch(`/api/employees`).then((r) => r.json()),
    fetch(`/api/attendance?limit=12`).then((r) => r.json()),
  ]);

  const totalEmployees = (employeesRes.employees || []).length;
  const reportEmployees = reportRes.employees || [];
  const checkedIn = reportEmployees.filter((e) => e.currentStatus === 'INSIDE').length;
  const checkedOut = reportEmployees.filter((e) => e.currentStatus === 'OUTSIDE').length;
  const notArrived = Math.max(0, totalEmployees - reportEmployees.length);

  document.getElementById('totalEmployees').textContent = totalEmployees;
  document.getElementById('checkedIn').textContent = checkedIn;
  document.getElementById('checkedOut').textContent = checkedOut;
  document.getElementById('notArrived').textContent = notArrived;
  document.getElementById('statusCount').textContent = reportEmployees.length + ' employee(s) with activity today';

  const tbody = document.querySelector('#statusTable tbody');
  tbody.innerHTML = reportEmployees.length ? reportEmployees.map((row) => {
    const lastPunch = row.punches && row.punches.length ? row.punches[row.punches.length - 1].recordTime : null;
    const minutes = Math.round((row.insideMs || 0) / 60000);
    const badgeClass = row.currentStatus === 'INSIDE' ? 'IN' : 'OUT';
    return `<tr>
      <td>${empCell(row.employeeName, row.deviceUserId)}</td>
      <td><span class="badge ${badgeClass}">${row.currentStatus}</span></td>
      <td>${fmtTime(row.firstIn)}</td>
      <td>${fmtTime(lastPunch)}</td>
      <td>${statusPill(classifyToday(minutes, row.punchCount))} ${fmtHours(minutes)}</td>
      <td>${row.punchCount}</td>
    </tr>`;
  }).join('') : emptyRow(6, 'No punches recorded for this date yet.');

  const feed = document.getElementById('punchFeed');
  const records = punchesRes.records || [];
  feed.innerHTML = records.length ? records.map((p) => `<div class="feed-item">
      <div class="avatar">${initials(p.employeeName, p.deviceUserId)}</div>
      <div class="feed-main">
        <div class="feed-name">${p.employeeName || '#' + p.deviceUserId}</div>
        <div class="feed-meta">${fmtShortTime(p.recordTime)} &middot; ${verifyModeLabel(p)}</div>
      </div>
      <span class="badge ${p.punchType}">${p.punchType}</span>
    </div>`).join('') : '<div class="feed-empty">No recent punches.</div>';
}

async function refreshAll() {
  const date = datePicker.value || todayStr();
  refreshBtn.classList.add('loading');
  await loadDashboardTab(date);
  refreshBtn.classList.remove('loading');
  lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString('en-IN')}`;
}

refreshBtn.addEventListener('click', refreshAll);
datePicker.addEventListener('change', refreshAll);

// ---------- Employees (monthly) view ----------
const monthPicker = document.getElementById('monthPicker');
monthPicker.value = currentMonthStr();

async function loadEmployeesSummary() {
  const month = monthPicker.value || currentMonthStr();
  const data = await fetch(`/api/monthly-summary?month=${month}`).then((r) => r.json());
  const tbody = document.querySelector('#employeesSummaryTable tbody');
  const employees = data.employees || [];
  tbody.innerHTML = employees.length ? employees.map((e) => `<tr data-id="${e.deviceUserId}">
      <td>${empCell(e.name, e.deviceUserId)}</td>
      <td>${e.presentDays}</td>
      <td>${fmtHours(e.totalMinutes)}</td>
      <td>${fmtHours(e.avgMinutes)}</td>
      <td>${statusPill(e.overallQuality)}</td>
    </tr>`).join('') : emptyRow(5, 'No employees found.');
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openEmployeeDetail(tr.dataset.id, month));
  });
}

monthPicker.addEventListener('change', loadEmployeesSummary);

// ---------- Employee detail view ----------
const detailMonthPicker = document.getElementById('detailMonthPicker');
const backBtn = document.getElementById('backBtn');
let currentEmployeeId = null;

backBtn.addEventListener('click', () => showView('employeesView'));
detailMonthPicker.addEventListener('change', () => {
  if (currentEmployeeId) loadEmployeeDetail(currentEmployeeId, detailMonthPicker.value);
});

function openEmployeeDetail(deviceUserId, month) {
  currentEmployeeId = deviceUserId;
  detailMonthPicker.value = month || currentMonthStr();
  showView('employeeDetailView');
  loadEmployeeDetail(deviceUserId, detailMonthPicker.value);
}

async function loadEmployeeDetail(deviceUserId, month) {
  const data = await fetch(`/api/monthly-summary/${encodeURIComponent(deviceUserId)}?month=${month}`).then((r) => r.json());
  if (data.error) { alert(data.error); return; }

  document.getElementById('empAvatar').textContent = initials(data.employee.name, data.employee.deviceUserId);
  document.getElementById('empDetailName').textContent = data.employee.name || ('#' + data.employee.deviceUserId);
  document.getElementById('empDetailMeta').textContent = `#${data.employee.deviceUserId}${data.employee.department ? ' · ' + data.employee.department : ''}${data.employee.designation ? ' · ' + data.employee.designation : ''} · ${data.month}`;

  document.getElementById('empTotalHours').innerHTML = fmtHours(data.summary.totalMinutes);
  document.getElementById('empPresentDays').textContent = data.summary.presentDays;
  document.getElementById('empAvgHours').innerHTML = fmtHours(data.summary.avgMinutes);
  document.getElementById('empGreenDays').textContent = data.summary.greenDays;
  document.getElementById('empOrangeDays').textContent = data.summary.orangeDays;
  document.getElementById('empRedDays').textContent = data.summary.redDays;

  const tbody = document.querySelector('#empDailyTable tbody');
  const days = (data.days || []).filter((d) => d.status !== 'future');
  tbody.innerHTML = days.length ? days.map((d) => `<tr>
      <td>${d.date}</td>
      <td>${fmtTime(d.firstIn)}</td>
      <td>${fmtTime(d.lastOut)}${d.hasIncompletePunch ? ' <span class="muted">(still IN)</span>' : ''}</td>
      <td>${(d.sessions || []).length}</td>
      <td>${fmtHours(d.minutes)}</td>
      <td>${statusPill(d.status)}</td>
    </tr>`).join('') : emptyRow(6, 'No data for this month.');
}

// ---------- init ----------
refreshAll();
setInterval(refreshAll, 30000);
