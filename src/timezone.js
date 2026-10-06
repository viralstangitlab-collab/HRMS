// All attendance dates, the 6 AM workday cutoff and month boundaries are
// computed with local-time Date methods. Pin the process to the office
// timezone so reports are identical whether the host runs in IST or UTC.
process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
