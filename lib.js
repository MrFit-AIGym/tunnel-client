import { createHash } from "node:crypto";

const DEFAULT_TIME_ZONE = "America/Mexico_City";

export function hashEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return createHash("sha256").update(email, "utf8").digest("hex");
}

export function memberEmailHash(member) {
  return memberEmailHashes(member)[0] ?? null;
}

export function memberEmailHashes(member) {
  const hashes = new Set();
  for (const contact of Array.isArray(member?.contacts) ? member.contacts : []) {
    const hash = hashEmail(contact?.description);
    if (hash) hashes.add(hash);
  }
  return [...hashes];
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function isSuccessfulEntry(entry) {
  const action = normalizeText(entry?.entryAction);
  const reason = normalizeText(entry?.blockReason);
  const combined = `${action} ${reason}`.trim();

  if (/bloq|block|tentat|denied|negad|recus|fail|erro|inativ|deud|saldo|nao.*encontr|no.*encontr/.test(combined)) return false;
  if (/liber|autor|allow|success|sucesso|entrada|entry|validado|validada/.test(combined)) return true;
  return !combined;
}

export function localDateKey(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function localDateTime(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function sortEntriesChronologically(entries) {
  return [...entries].sort((left, right) => {
    const leftTime = new Date(left?.date ?? 0).getTime();
    const rightTime = new Date(right?.date ?? 0).getTime();

    if (!Number.isFinite(leftTime)) return 1;
    if (!Number.isFinite(rightTime)) return -1;

    return leftTime - rightTime;
  });
}

export function uniqueAttendances(
  entries,
  {
    timeZone = "America/Mexico_City",
    startDate,
    endDate,
    idBranch,
  } = {},
) {
  const seen = new Set();
  const attendances = [];
  let blockedOrUnsuccessful = 0;

  for (const entry of entries) {
    if (
      idBranch !== undefined &&
      Number(entry?.idBranch) !== Number(idBranch)
    ) {
      continue;
    }

    const day = localDateKey(entry?.date, timeZone);
    if (!day) continue;
    if (startDate && day < startDate) continue;
    if (endDate && day > endDate) continue;

    if (!entry?.idMember || !isSuccessfulEntry(entry)) {
      blockedOrUnsuccessful += 1;
      continue;
    }

    const key = `${entry.idMember}|${entry.idBranch ?? "sin-sucursal"}|${day}`;

    if (seen.has(key)) continue;
    seen.add(key);

    attendances.push({
      idMember: entry.idMember,
      nameMember: entry.nameMember ?? null,
      idBranch: entry.idBranch ?? null,
      date: day,
      entryDate: entry.date,
    });
  }

  attendances.sort((left, right) => {
    const leftTime = new Date(left.entryDate ?? left.date).getTime();
    const rightTime = new Date(right.entryDate ?? right.date).getTime();
    return leftTime - rightTime;
  });

  return {
    attendances,
    blockedOrUnsuccessful,
  };
}

export function safeAttendanceDetail(
  attendance,
  timeZone = DEFAULT_TIME_ZONE,
  emailHashes = null,
) {
  const safeEmailHashes = [...new Set(
    (Array.isArray(emailHashes) ? emailHashes : [emailHashes])
      .filter((hash) => /^[0-9a-f]{64}$/i.test(String(hash ?? ""))),
  )];

  return {
    idMember:
      attendance?.idMember == null ? null : Number(attendance.idMember),
    nameMember: String(attendance?.nameMember ?? "").trim() || null,
    idBranch:
      attendance?.idBranch == null ? null : Number(attendance.idBranch),
    date: attendance?.date ?? null,
    firstEntryAt: attendance?.entryDate ?? null,
    firstEntryLocal: localDateTime(attendance?.entryDate, timeZone),
    emailHash: safeEmailHashes[0] ?? null,
    emailHashes: safeEmailHashes,
  };
}

export function rankAttendances(attendances, top = 10) {
  const byMember = new Map();
  const byDay = new Map();

  for (const item of attendances) {
    const current = byMember.get(item.idMember) ?? {
      idMember: item.idMember,
      nameMember: item.nameMember,
      attendanceCount: 0,
    };
    current.attendanceCount += 1;
    if (!current.nameMember && item.nameMember) current.nameMember = item.nameMember;
    byMember.set(item.idMember, current);
    byDay.set(item.date, (byDay.get(item.date) ?? 0) + 1);
  }

  const ranking = [...byMember.values()]
    .sort((a, b) => b.attendanceCount - a.attendanceCount || a.nameMember.localeCompare(b.nameMember))
    .slice(0, top);
  const dailyTotals = [...byDay.entries()]
    .map(([date, attendanceCount]) => ({ date, attendanceCount }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { ranking, dailyTotals, uniqueMembers: byMember.size };
}

export function validateDateRange(startDate, endDate, maxDays) {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(startDate) || !pattern.test(endDate)) {
    throw new Error("Las fechas deben usar el formato AAAA-MM-DD.");
  }
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw new Error("El periodo de fechas no es válido.");
  }
  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days > maxDays) {
    throw new Error(`El periodo máximo permitido para esta consulta es de ${maxDays} días.`);
  }
  return { start, end, days };
}

export function expandedUtcRange(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T23:59:59.999Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  end.setUTCDate(end.getUTCDate() + 1);
  return { registerDateStart: start.toISOString(), registerDateEnd: end.toISOString() };
}

export function safeMembership(membership) {
  return {
    idMember: membership?.idMember == null ? null : Number(membership.idMember),
    name: String(membership?.name ?? "").trim(),
    idMembership: membership?.idMembership == null ? null : Number(membership.idMembership),
    idMemberMembership: membership?.idMemberMemberShip == null
      ? null
      : Number(membership.idMemberMemberShip),
    idBranch: membership?.idBranch == null ? null : Number(membership.idBranch),
    nameMembership: String(membership?.nameMembership ?? "").trim(),
    membershipStart: membership?.membershipStart ?? null,
    membershipEnd: membership?.membershipEnd ?? null,
    status: Number(membership?.statusMemberMembership) === 1
      ? "activo"
      : Number(membership?.statusMemberMembership) === 2
        ? "cancelado"
        : "desconocido",
  };
}
